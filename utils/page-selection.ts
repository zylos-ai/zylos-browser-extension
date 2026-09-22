import { z } from 'zod';

export const MAX_SELECTION_TEXT = 4000;
export const pageSelectionSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SELECTION_TEXT)
      .refine((text) => JSON.stringify(text).length <= 8002),
    truncated: z.boolean(),
    selectionVersion: z.number().int().nonnegative().optional(),
    tabId: z.number().int().nonnegative(),
    documentId: z.string().min(1).max(128),
    url: z.string().url().max(4000),
    title: z.string().max(300),
  })
  .strict();
export type PageSelection = z.infer<typeof pageSelectionSchema>;

export const selectionKey = (selection: PageSelection) =>
  JSON.stringify([
    selection.tabId,
    selection.documentId,
    selection.url,
    selection.text,
    selection.selectionVersion,
  ]);

export async function readPageSelection(tabId: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: extractPageSelection,
        args: [MAX_SELECTION_TEXT, true],
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SELECTION_TIMEOUT')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Serialized by executeScript. Reads only the main document's selected prose. */
export function extractPageSelection(limit: number, watch = false) {
  const read = () => {
    const result = { url: location.href, text: '', truncated: false };
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return result;
    // Form/editor selections are not implicit attachments, especially passwords/OTPs.
    const excluded =
      'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"]';
    const excludedAncestor = (node: Node | null): boolean => {
      let element = node instanceof Element ? node : node?.parentElement;
      while (element) {
        if (element.matches(excluded)) return true;
        const root = element.getRootNode();
        element = element.parentElement || (root instanceof ShadowRoot ? root.host : null);
      }
      return false;
    };
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    if (excludedAncestor(focused)) return result;
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    if (excludedAncestor(container)) return result;
    const scope =
      container instanceof Element || container instanceof ShadowRoot ? container : null;
    const mixed =
      scope && Array.from(scope.querySelectorAll(excluded)).some((el) => range.intersectsNode(el));
    let text: string;
    let limited = false;
    if (mixed) {
      // Keep only selected prose. Range.toString()/cloneContents() alone would
      // also expose textarea defaults, editor drafts and hidden descendants.
      const chunks: string[] = [];
      let length = 0,
        visited = 0;
      const started = performance.now();
      const append = (value: string) => {
        const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
        const part = length ? clean : clean.trimStart();
        const remaining = limit + 1 - length;
        if (part.length > remaining) limited = true;
        const kept = part.slice(0, remaining);
        chunks.push(kept);
        length += kept.length;
      };
      const walk = (node: Node, depth = 0) => {
        if (limited) return;
        if (++visited > 10000 || depth > 100 || performance.now() - started > 100) {
          limited = true;
          return;
        }
        if (!range.intersectsNode(node)) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const start = node === range.startContainer ? range.startOffset : 0;
          const end = node === range.endContainer ? range.endOffset : node.textContent!.length;
          append(node.textContent!.slice(start, end));
          return;
        }
        let block = false;
        if (node instanceof Element) {
          if (node.matches(excluded)) {
            append('\n');
            return;
          }
          if (node.matches('script,style,noscript,template,[hidden],[inert],[aria-hidden="true"]'))
            return;
          const style = getComputedStyle(node);
          if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return;
          block = ['block', 'list-item', 'flex', 'grid', 'table-row'].includes(style.display);
          if (node.tagName === 'BR') append('\n');
          if (block) append('\n');
        }
        for (const child of node.childNodes) {
          walk(child, depth + 1);
          if (limited) break;
        }
        if (block && !limited) append('\n');
      };
      walk(container);
      text = chunks
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    } else {
      text = selection
        .toString()
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .trim();
    }
    return {
      url: location.href,
      text: text.slice(0, limit),
      truncated: limited || text.length > limit,
    };
  };
  if (!watch) return read();
  // Track the current selection, including cancellation. The listener expires
  // shortly after the panel stops reading; cleared text must not stay cached.
  type Watcher = {
    value: ReturnType<typeof read> & { selectionVersion: number };
    listening: boolean;
    capture: () => void;
    dispose: () => void;
    timer?: ReturnType<typeof setTimeout>;
  };
  const scope = globalThis as typeof globalThis & { __zylosSelectionPreview?: Watcher };
  let watcher = scope.__zylosSelectionPreview;
  if (!watcher) {
    let previous: unknown[] = [];
    const observer: Watcher = {
      value: { url: location.href, text: '', truncated: false, selectionVersion: 0 },
      listening: false,
      capture: () => {
        const s = window.getSelection();
        const value = read();
        const shape = [
          s?.anchorNode,
          s?.anchorOffset,
          s?.focusNode,
          s?.focusOffset,
          s?.isCollapsed,
          value.text,
          value.truncated,
        ];
        if (shape.every((part, index) => part === previous[index])) return;
        previous = shape;
        observer.value = { ...value, selectionVersion: observer.value.selectionVersion + 1 };
      },
      dispose: () => {
        document.removeEventListener('selectionchange', observer.capture);
        observer.listening = false;
        // Keep the counter stable across hidden panels so a consumed selection
        // is not mistaken for a new one. This cache never leaves the document.
      },
    };
    watcher = scope.__zylosSelectionPreview = observer;
  }
  if (!watcher.listening) {
    document.addEventListener('selectionchange', watcher.capture);
    watcher.listening = true;
  }
  watcher.capture();
  clearTimeout(watcher.timer);
  watcher.timer = setTimeout(watcher.dispose, 2000);
  return watcher.value;
}
