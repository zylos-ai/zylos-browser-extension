import { isBlockedUrl } from './guard';

export function canReadPage(tab: chrome.tabs.Tab) {
  try {
    const url = new URL(tab.url || '');
    return (
      tab.id !== undefined &&
      !tab.incognito &&
      !tab.pendingUrl &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !['chromewebstore.google.com', 'chrome.google.com'].includes(url.hostname) &&
      !isBlockedUrl(url.href)
    );
  } catch {
    return false;
  }
}

export type PageDocument = { tabId: number; windowId: number; url: string; documentId: string };
export type ReadPageOptions = {
  offset?: number;
  limit?: number;
  contentVersion?: string;
  /** Pre-send overview: the viewport digest plus a heading outline of the whole page. */
  overview?: boolean;
};
function fail(code: string, message = code): never {
  throw Object.assign(new Error(message), { code });
}

// Chrome's document ID survives focus changes but changes on same-URL reloads.
// A tab ID or URL alone is not enough to authorize a later read or operation.
export async function getPageDocument(
  tab: chrome.tabs.Tab & { id: number },
): Promise<PageDocument> {
  if (!canReadPage(tab)) fail('PAGE_UNAVAILABLE');
  const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
  if (!frame?.documentId || frame.url !== tab.url) fail('PAGE_CHANGED');
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url!, documentId: frame.documentId };
}

export async function assertPageDocument(expected: PageDocument) {
  const tab = await chrome.tabs.get(expected.tabId).catch(() => null);
  if (!tab || !canReadPage(tab) || tab.windowId !== expected.windowId || tab.url !== expected.url)
    fail('PAGE_CHANGED');
  const actual = await getPageDocument({ ...tab, id: expected.tabId });
  if (actual.documentId !== expected.documentId) fail('PAGE_CHANGED');
}

/** Serialized by executeScript: all dependencies must stay inside this function. */
export function extractPageText(options: ReadPageOptions = {}) {
  const offset = options.offset || 0;
  const limit = options.limit || 6000;
  const started = performance.now();
  const maxText = 120000;
  const chunks: string[] = [];
  const links: { text: string; url: string }[] = [];
  const headings: { level: number; name: string; solid: number; top?: number }[] = [];
  const seen = new WeakSet<Node>();
  const linked = new Set<string>();
  // Normalization below only rewrites whitespace, so a count of the
  // non-whitespace characters before a heading locates it in the final text.
  let solid = 0;
  let length = 0,
    visited = 0,
    limited = false;
  const append = (text: string) => {
    const remaining = maxText - length;
    if (text.length > remaining) limited = true;
    const part = text.slice(0, remaining);
    chunks.push(part);
    length += part.length;
    solid += part.replace(/\s+/g, '').length;
  };
  const excluded =
    'script,style,noscript,template,input,textarea,select,option,[hidden],[inert],[aria-hidden="true"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"]';
  const blocks = new Set([
    'DIV',
    'P',
    'ARTICLE',
    'MAIN',
    'SECTION',
    'HEADER',
    'FOOTER',
    'NAV',
    'ASIDE',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'LI',
    'UL',
    'OL',
    'TR',
    'BLOCKQUOTE',
    'PRE',
    'BR',
  ]);
  const walk = (node: Node, depth: number) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (
      ++visited > 20000 ||
      length >= maxText ||
      depth > 100 ||
      performance.now() - started > 250
    ) {
      limited = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.replace(/\s+/g, ' ') || '';
      if (text) append(text);
      return;
    }
    if (!(node instanceof Element)) return;
    if (
      node.matches(excluded) ||
      (node instanceof HTMLElement && node.isContentEditable) ||
      (node.hasAttribute('contenteditable') && node.getAttribute('contenteditable') !== 'false')
    )
      return;
    const style = getComputedStyle(node);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    )
      return;
    const block = blocks.has(node.tagName);
    if (block) append('\n');
    const textStart = chunks.length;
    const solidStart = solid;
    let children: Node[] = Array.from(node.shadowRoot?.childNodes || node.childNodes);
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) children = assigned;
    }
    if (node instanceof HTMLDetailsElement && !node.open)
      children = children.filter(
        (child) => child instanceof Element && child.tagName === 'SUMMARY',
      );
    for (const child of children) {
      walk(child, depth + 1);
      if (limited) break;
    }
    if (node instanceof HTMLAnchorElement && links.length < 40) {
      try {
        const url = new URL(node.href);
        const text = chunks.slice(textStart).join('').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (
          text &&
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.href.length <= 1500 &&
          !linked.has(url.href)
        ) {
          linked.add(url.href);
          links.push({ text, url: url.href });
        }
      } catch {
        /* A malformed link is not page content. */
      }
    }
    const level =
      /^H([1-6])$/.exec(node.tagName)?.[1] ??
      (node.getAttribute('role') === 'heading'
        ? node.getAttribute('aria-level') || '2'
        : undefined);
    if (level && headings.length < 200) {
      const name = chunks.slice(textStart).join('').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (name)
        headings.push({
          level: Math.min(6, Math.max(1, Number(level) || 2)),
          name,
          solid: solidStart,
          top: options.overview ? node.getBoundingClientRect().top : undefined,
        });
    }
    if (block) append('\n');
  };
  // What the owner currently sees, in snapshot-style `- role "name"` lines. No
  // refs: actionable refs still require use-current-tab and a CDP snapshot.
  const readViewport = () => {
    const started = performance.now();
    const width = innerWidth;
    const height = innerHeight;
    const root = document.scrollingElement || document.documentElement;
    const contentHeight = Math.max(root.scrollHeight, document.body?.scrollHeight || 0, height);
    type Box = { left: number; top: number; right: number; bottom: number };
    const screen: Box = { left: 0, top: 0, right: width, bottom: height };
    const clipTo = (a: Box, b: Box): Box => ({
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
    });
    const shown = (box: Box) => box.right > box.left && box.bottom > box.top;
    const range = document.createRange();
    const lines: string[] = [];
    let chars = 0,
      seen = 0,
      truncated = false,
      cut = false,
      pending = '';
    let named: { role: string; text: string; url?: string } | undefined;
    const safeUrl = (href: string) => {
      try {
        const url = new URL(href);
        return ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.href.length <= 1500
          ? url.href
          : undefined;
      } catch {
        return undefined;
      }
    };
    const emit = (role: string, name: string, url?: string) => {
      name = name.replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!name && !url) return;
      const line = `- ${role} ${JSON.stringify(name)}${url ? ` ${JSON.stringify({ url })}` : ''}`;
      if (chars + line.length + 1 > 6000) {
        truncated = true;
        return;
      }
      lines.push(line);
      chars += line.length + 1;
    };
    const flush = () => {
      emit('StaticText', pending);
      pending = '';
    };
    const append = (text: string) => {
      if (named) named.text += text;
      else pending += text;
    };
    const roles = new Set([
      'button',
      'link',
      'heading',
      'tab',
      'menuitem',
      'checkbox',
      'radio',
      'switch',
      'option',
    ]);
    const fields =
      'input,textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"]';
    const roleOf = (element: Element) => {
      const explicit = element.getAttribute('role');
      if (explicit && roles.has(explicit)) return explicit;
      if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) return 'link';
      if (/^H[1-6]$/.test(element.tagName)) return 'heading';
      if (['BUTTON', 'SUMMARY'].includes(element.tagName)) return 'button';
      return undefined;
    };
    // Form values are owner data and never leave the page; only labels do.
    const fieldLabel = (element: Element) => {
      const input = element instanceof HTMLInputElement ? element : undefined;
      if (input && ['button', 'submit', 'reset'].includes(input.type))
        return { role: 'button', name: element.getAttribute('aria-label') || input.value };
      const role =
        element.getAttribute('role') ||
        (element instanceof HTMLSelectElement
          ? 'combobox'
          : input && ['checkbox', 'radio'].includes(input.type)
            ? input.type
            : 'textbox');
      const labels = (element as HTMLInputElement).labels;
      const name =
        element.getAttribute('aria-label') ||
        element.getAttribute('placeholder') ||
        element.getAttribute('title') ||
        (labels?.length ? labels[0]!.textContent || '' : '');
      return { role, name: name || `(${input?.type || element.tagName.toLowerCase()})` };
    };
    // Skip controls covered by a modal or overlay, as nanobrowser does.
    const covered = (element: Element, box: Box) => {
      const host = element.getRootNode() as Document | ShadowRoot;
      const hit = host.elementFromPoint?.((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return !!hit && hit !== element && !element.contains(hit) && !hit.contains(element);
    };
    const visit = (node: Node, clip: Box, depth: number) => {
      if (truncated || cut) return;
      if (++seen > 20000 || depth > 100 || performance.now() - started > 250) {
        cut = true;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.replace(/\s+/g, ' ') || '';
        if (!text.trim()) {
          if (text) append(' ');
          return;
        }
        range.selectNodeContents(node);
        if (shown(clipTo(range.getBoundingClientRect(), clip))) append(text);
        return;
      }
      if (!(node instanceof Element)) return;
      if (
        node.matches('script,style,noscript,template,option,[hidden],[inert],[aria-hidden="true"]')
      )
        return;
      const style = getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      )
        return;
      const box = node.getBoundingClientRect();
      if (style.position === 'fixed') clip = screen;
      const inside = clipTo(box, clip);
      if (
        node.matches(fields) ||
        (node instanceof HTMLElement && node.isContentEditable) ||
        (node.hasAttribute('contenteditable') && node.getAttribute('contenteditable') !== 'false')
      ) {
        if (!named && shown(inside) && !covered(node, inside)) {
          flush();
          const field = fieldLabel(node);
          emit(field.role, field.name);
        }
        return;
      }
      if (node instanceof HTMLImageElement) {
        const alt = node.alt.trim();
        if (alt && shown(inside)) {
          if (named) named.text += ` ${alt} `;
          else {
            flush();
            emit('img', alt);
          }
        }
        return;
      }
      // Root overflow applies to the viewport itself, not to these boxes.
      if (node !== document.body && node !== document.documentElement) {
        const x = style.overflowX !== 'visible';
        const y = style.overflowY !== 'visible';
        if (x || y)
          clip = clipTo(clip, {
            left: x ? box.left : -Infinity,
            right: x ? box.right : Infinity,
            top: y ? box.top : -Infinity,
            bottom: y ? box.bottom : Infinity,
          });
        if (!shown(clip)) return;
      }
      const role = named ? undefined : roleOf(node);
      if (role && (!shown(inside) || covered(node, inside))) return;
      if (named && node instanceof HTMLAnchorElement) named.url ??= safeUrl(node.href);
      const block = blocks.has(node.tagName);
      if (role || (block && !named)) flush();
      if (role)
        named = {
          role,
          text: '',
          url: node instanceof HTMLAnchorElement ? safeUrl(node.href) : undefined,
        };
      let children: Node[] = Array.from(node.shadowRoot?.childNodes || node.childNodes);
      if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) children = assigned;
      }
      if (node instanceof HTMLDetailsElement && !node.open)
        children = children.filter(
          (child) => child instanceof Element && child.tagName === 'SUMMARY',
        );
      for (const child of children) visit(child, clip, depth + 1);
      if (role && named) {
        const { text, url } = named;
        named = undefined;
        emit(
          role,
          text.trim() || node.getAttribute('aria-label') || node.getAttribute('title') || '',
          url,
        );
      } else if (block && !named) flush();
    };
    if (document.body) visit(document.body, screen, 0);
    flush();
    return {
      text: lines.join('\n'),
      truncated: truncated || cut,
      limited: cut,
      width,
      height,
      scrollX: Math.round(scrollX),
      scrollY: Math.round(scrollY),
      contentHeight,
      remainingBelow: Math.max(0, Math.round(contentHeight - scrollY - height)),
    };
  };
  const viewport = options.overview ? readViewport() : undefined;
  if (document.body) walk(document.body, 0);
  const text = chunks
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  const end = Math.min(text.length, offset + limit);
  // Offsets let the Agent read-page straight to a section of the same text.
  const offsets = new Map<number, number>();
  if (viewport) {
    const wanted = new Set(headings.map((h) => h.solid));
    for (let i = 0, k = 0; i < text.length && offsets.size < wanted.size; i++) {
      if (/\s/.test(text[i]!)) continue;
      if (wanted.has(k)) offsets.set(k, i);
      k++;
    }
  }
  const outline = viewport
    ? headings
        .sort((a, b) => a.solid - b.solid)
        .map(({ level, name, solid, top }) => ({
          level,
          name,
          offset: offsets.get(solid),
          position: top! < 0 ? 'above' : top! < viewport.height ? 'in-view' : 'below',
        }))
    : undefined;
  return {
    url: location.href,
    title: document.title.slice(0, 300),
    text: text.slice(offset, end),
    links: offset === 0 ? links : [],
    offset,
    nextOffset: end < text.length ? end : null,
    contentVersion: `${text.length}-${(hash >>> 0).toString(16)}`,
    truncated: end < text.length || limited,
    limited,
    textLength: text.length,
    ...(viewport ? { viewport, outline } : {}),
  };
}

export async function readPageDocument(
  expected: PageDocument,
  options: ReadPageOptions = {},
  assertActive: () => void = () => {},
  timeoutMs?: number,
) {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellationTimer: ReturnType<typeof setInterval> | undefined;
  const check = () => {
    assertActive();
    if (settled) fail('CONTEXT_CANCELLED');
  };
  const read = async () => {
    check();
    await assertPageDocument(expected);
    check();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: expected.tabId, documentIds: [expected.documentId] },
      world: 'ISOLATED',
      func: extractPageText,
      args: [options],
    });
    check();
    await assertPageDocument(expected);
    check();
    if (
      !result?.result ||
      result.documentId !== expected.documentId ||
      result.result.url !== expected.url
    )
      fail('PAGE_CHANGED');
    const page = result.result;
    if (options.contentVersion && options.contentVersion !== page.contentVersion)
      fail(
        'PAGE_CONTENT_CHANGED',
        'Page text changed. Read again from offset 0; do not join chunks from different content versions.',
      );
    return { ...page, capturedAt: new Date().toISOString(), documentId: expected.documentId };
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        // A slow executeScript must remain cancellable even if Chrome never replies.
        cancellationTimer = setInterval(() => {
          try {
            check();
          } catch (error) {
            reject(error);
          }
        }, 50);
        // Only the optional, pre-send page overview uses a short UI budget.
        // Agent-requested reads have no execution deadline.
        if (timeoutMs !== undefined)
          timer = setTimeout(() => {
            reject(Object.assign(new Error('CONTEXT_TIMEOUT'), { code: 'CONTEXT_TIMEOUT' }));
          }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    clearInterval(cancellationTimer);
    settled = true;
  }
}
