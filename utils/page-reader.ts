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
export type ReadPageOptions = { offset?: number; limit?: number; contentVersion?: string };
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
  const seen = new WeakSet<Node>();
  const linked = new Set<string>();
  let length = 0,
    visited = 0,
    limited = false;
  const append = (text: string) => {
    const remaining = maxText - length;
    if (text.length > remaining) limited = true;
    const part = text.slice(0, remaining);
    chunks.push(part);
    length += part.length;
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
    if (block) append('\n');
  };
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
  };
}

export async function readPageDocument(
  expected: PageDocument,
  options: ReadPageOptions = {},
  assertActive: () => void = () => {},
) {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    assertActive();
    if (expired) fail('CONTEXT_TIMEOUT');
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
        timer = setTimeout(() => {
          expired = true;
          reject(Object.assign(new Error('CONTEXT_TIMEOUT'), { code: 'CONTEXT_TIMEOUT' }));
        }, 2500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    expired = true;
  }
}
