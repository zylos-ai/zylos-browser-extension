import {
  assertPageDocument,
  canReadPage,
  getPageDocument,
  type PageDocument,
} from '../page-reader';

export type IncidentPageState = {
  visibility: 'visible' | 'hidden' | 'other';
  readyState: 'loading' | 'interactive' | 'complete';
  scheme: 'http' | 'https';
  iframeCount: number;
  iframeCountCapped: boolean;
  focusedElement: 'input' | 'textarea' | 'select' | 'button' | 'other' | 'none';
  inputFocused: boolean;
  inputDisabled: boolean;
  inputReadOnly: boolean;
};
export type IncidentPageCapture = {
  status: 'captured' | 'unavailable' | 'stale';
  observedAt: number;
  state?: IncidentPageState;
};

async function bounded<T>(
  isCurrent: () => boolean,
  work: (check: () => void) => Promise<T>,
): Promise<T> {
  let ended = false;
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    if (ended || !isCurrent()) throw Object.assign(new Error(), { code: 'STALE' });
  };
  try {
    return await Promise.race([
      work(check),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ended = true;
          reject(new Error());
        }, 1000);
      }),
    ]);
  } finally {
    ended = true;
    clearTimeout(timer!);
  }
}

export async function pinIncidentDocument(
  tabId: number,
  isCurrent: () => boolean,
): Promise<PageDocument | undefined> {
  try {
    return await bounded(isCurrent, async (check) => {
      check();
      const tab = await chrome.tabs.get(tabId);
      check();
      if (!canReadPage(tab)) return undefined;
      const expected = await getPageDocument({ ...tab, id: tabId });
      check();
      await assertPageDocument(expected);
      check();
      return expected;
    });
  } catch {
    return undefined;
  }
}

// Serialized by Chrome; deliberately reads no attributes, text, or input values.
export function incidentPageStateProbe(): { observedAt: number; state?: IncidentPageState } {
  const observedAt = Date.now();
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return { observedAt };
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  const deadline = performance.now() + 8;
  let visited = 0;
  let iframeCount = 0;
  let node = walker.nextNode();
  while (node && visited < 512 && performance.now() < deadline) {
    visited++;
    if ((node as Element).localName === 'iframe') iframeCount++;
    node = walker.nextNode();
  }
  const focused = document.activeElement;
  const tag = focused?.localName;
  const focusedElement: IncidentPageState['focusedElement'] = !focused
    ? 'none'
    : tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button'
      ? tag
      : 'other';
  const inputFocused =
    focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement;
  return {
    observedAt,
    state: {
      visibility:
        document.visibilityState === 'visible'
          ? 'visible'
          : document.visibilityState === 'hidden'
            ? 'hidden'
            : 'other',
      readyState: document.readyState,
      scheme: location.protocol === 'http:' ? 'http' : 'https',
      iframeCount,
      iframeCountCapped: node !== null,
      focusedElement,
      inputFocused,
      inputDisabled: inputFocused && focused.disabled,
      inputReadOnly: inputFocused && focused.readOnly,
    },
  };
}

function sanitize(value: unknown): { observedAt: number; state: IncidentPageState } | undefined {
  if (!value || typeof value !== 'object') return;
  const { observedAt, state: s } = value as { observedAt: number; state: IncidentPageState };
  if (
    !Number.isFinite(observedAt) ||
    observedAt < 0 ||
    !s ||
    !['visible', 'hidden', 'other'].includes(s.visibility) ||
    !['loading', 'interactive', 'complete'].includes(s.readyState) ||
    !['http', 'https'].includes(s.scheme) ||
    !Number.isInteger(s.iframeCount) ||
    s.iframeCount < 0 ||
    s.iframeCount > 512 ||
    !['input', 'textarea', 'select', 'button', 'other', 'none'].includes(s.focusedElement) ||
    [s.iframeCountCapped, s.inputFocused, s.inputDisabled, s.inputReadOnly].some(
      (v) => typeof v !== 'boolean',
    )
  )
    return;
  return {
    observedAt,
    state: {
      visibility: s.visibility,
      readyState: s.readyState,
      scheme: s.scheme,
      iframeCount: s.iframeCount,
      iframeCountCapped: s.iframeCountCapped,
      focusedElement: s.focusedElement,
      inputFocused: s.inputFocused,
      inputDisabled: s.inputDisabled,
      inputReadOnly: s.inputReadOnly,
    },
  };
}

export async function captureIncidentPageState(
  expected: PageDocument,
  isCurrent: () => boolean,
): Promise<IncidentPageCapture> {
  try {
    return await bounded(isCurrent, async (check) => {
      check();
      await assertPageDocument(expected);
      check();
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: expected.tabId, documentIds: [expected.documentId] },
        world: 'ISOLATED',
        func: incidentPageStateProbe,
      });
      check();
      await assertPageDocument(expected);
      check();
      if (result?.frameId !== 0 || result.documentId !== expected.documentId)
        return { status: 'stale', observedAt: Date.now() };
      const capture = sanitize(result.result);
      return capture
        ? { status: 'captured', ...capture }
        : { status: 'unavailable', observedAt: Date.now() };
    });
  } catch (error) {
    let stale = ['STALE', 'PAGE_CHANGED'].includes((error as { code?: string })?.code || '');
    try {
      stale ||= !isCurrent();
    } catch {
      stale = true;
    }
    return { status: stale ? 'stale' : 'unavailable', observedAt: Date.now() };
  }
}
