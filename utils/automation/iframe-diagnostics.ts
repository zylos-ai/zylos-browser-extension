import { canReadPage, getPageDocument, assertPageDocument } from '../page-reader';

type Scheme = 'http' | 'https' | 'extension' | 'about' | 'data' | 'blob' | 'other';
type Status =
  'buffer-overflow' | 'frame-cap' | 'event-cap' | 'scan-budget' | 'expired' | 'unavailable';
export type FrameDiagnostic = { observedAt: number } & (
  | {
      event: 'iframe-added' | 'iframe-removed' | 'iframe-src';
      frame: number;
      scheme: Scheme;
    }
  | { event: 'iframe-status'; status: Status }
);

// Self-contained: Chrome serializes this function into the isolated world.
export function frameDiagnosticProbe(key: string, action: 'start' | 'drain' | 'stop') {
  type State = { drain: () => FrameDiagnostic[]; stop: () => void };
  const host = globalThis as unknown as Record<string, State | undefined>;
  if (action === 'stop') {
    host[key]?.stop();
    return [];
  }
  if (action === 'drain')
    return (
      host[key]?.drain() ?? [
        {
          event: 'iframe-status',
          status: 'unavailable',
          observedAt: Date.now(),
        } as FrameDiagnostic,
      ]
    );
  if (host[key]) return [];
  const ids = new WeakMap<Element, number>();
  const statuses = new Map<Status, FrameDiagnostic>();
  const status = (value: Status) => {
    if (!statuses.has(value))
      statuses.set(value, { event: 'iframe-status', status: value, observedAt: Date.now() });
  };
  let next = 0;
  let total = 0;
  let ended = false;
  let buffer: FrameDiagnostic[] = [];
  const classify = (element: Element): Scheme => {
    try {
      const protocol = new URL(element.getAttribute('src') || 'about:blank', document.baseURI)
        .protocol;
      if (protocol === 'chrome-extension:') return 'extension';
      if (['http:', 'https:', 'about:', 'data:', 'blob:'].includes(protocol))
        return protocol.slice(0, -1) as Scheme;
    } catch {}
    return 'other';
  };
  const record = (element: Element, event: 'iframe-added' | 'iframe-removed' | 'iframe-src') => {
    if (ended || element.localName !== 'iframe') return;
    let frame = ids.get(element);
    if (frame === undefined) {
      if (next >= 256) {
        status('frame-cap');
        return;
      }
      frame = ++next;
      ids.set(element, frame);
    }
    const scheme = classify(element);
    if (buffer.length < 64) buffer.push({ event, frame, scheme, observedAt: Date.now() });
    else status('buffer-overflow');
    if (++total >= 512) {
      ended = true;
      observer.disconnect();
      status('event-cap');
    }
  };
  const walk = (
    node: Node,
    event: 'iframe-added' | 'iframe-removed',
    budget: { left: number; until: number },
  ) => {
    if (ended || budget.left <= 0) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let current: Node | null = node;
    while (current && budget.left-- > 0 && !ended && performance.now() < budget.until) {
      if (current.nodeType === Node.ELEMENT_NODE) record(current as Element, event);
      current = walker.nextNode();
    }
    if (current && !ended) status('scan-budget');
  };
  const observer = new MutationObserver((records) => {
    const budget = { left: 512, until: performance.now() + 8 };
    if (records.length > 128) status('scan-budget');
    for (const mutation of records.slice(0, 128)) {
      if (ended || budget.left <= 0 || performance.now() >= budget.until) {
        status('scan-budget');
        break;
      }
      if (mutation.type === 'attributes') {
        budget.left--;
        record(mutation.target as Element, 'iframe-src');
      } else {
        for (const node of mutation.removedNodes) {
          if (budget.left <= 0 || performance.now() >= budget.until) {
            status('scan-budget');
            break;
          }
          walk(node, 'iframe-removed', budget);
        }
        for (const node of mutation.addedNodes) {
          if (budget.left <= 0 || performance.now() >= budget.until) {
            status('scan-budget');
            break;
          }
          walk(node, 'iframe-added', budget);
        }
      }
    }
  });
  const stop = () => {
    ended = true;
    observer.disconnect();
    clearTimeout(timer);
    buffer = [];
    delete host[key];
  };
  const timer = setTimeout(stop, 120_000);
  host[key] = {
    drain: () => {
      const batch = [...buffer.splice(0, 64), ...statuses.values()];
      statuses.clear();
      return batch;
    },
    stop,
  };
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src'],
  });
  walk(document, 'iframe-added', { left: 512, until: performance.now() + 8 });
  return [];
}

export function startFrameDiagnostics(
  tabId: number,
  isCurrent: () => boolean,
  emit: (event: FrameDiagnostic) => void,
  canEmit: () => boolean = isCurrent,
): () => void {
  const key = `__coco_frame_diagnostic_${crypto.randomUUID()}`;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let documentId: string | undefined;
  const execute = (action: 'start' | 'drain' | 'stop') =>
    documentId
      ? chrome.scripting.executeScript({
          target: { tabId, documentIds: [documentId] },
          world: 'ISOLATED',
          func: frameDiagnosticProbe,
          args: [key, action],
        })
      : Promise.resolve([]);
  const signal = (status: Status) => {
    try {
      if (canEmit()) emit({ event: 'iframe-status', status, observedAt: Date.now() });
    } catch {}
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(expiry);
    void execute('drain')
      .then(deliver)
      .catch(() => {
        signal('unavailable');
      })
      .finally(() => {
        void execute('stop').catch(() => {});
      });
  };
  const expiry = setTimeout(() => {
    signal('expired');
    stop();
  }, 120_000);
  const active = () => {
    try {
      return !stopped && isCurrent();
    } catch {
      return false;
    }
  };
  const deliver = (results: Awaited<ReturnType<typeof execute>>) => {
    for (const result of results) {
      if (
        result.frameId !== 0 ||
        result.documentId !== documentId ||
        !Array.isArray(result.result)
      ) {
        signal('unavailable');
        continue;
      }
      for (const item of result.result.slice(0, 70)) {
        try {
          if (!canEmit()) return;
        } catch {
          return;
        }
        if (!item || !Number.isFinite(item.observedAt) || item.observedAt < 0) continue;
        if (item.event === 'iframe-status') {
          if (
            [
              'buffer-overflow',
              'frame-cap',
              'event-cap',
              'scan-budget',
              'expired',
              'unavailable',
            ].includes(item.status)
          )
            emit({ event: 'iframe-status', status: item.status, observedAt: item.observedAt });
          continue;
        }
        if (
          !['iframe-added', 'iframe-removed', 'iframe-src'].includes(item.event) ||
          !Number.isInteger(item.frame) ||
          item.frame < 1 ||
          item.frame > 256 ||
          !['http', 'https', 'extension', 'about', 'data', 'blob', 'other'].includes(item.scheme)
        )
          continue;
        emit({
          event: item.event,
          frame: item.frame,
          scheme: item.scheme,
          observedAt: item.observedAt,
        });
      }
    }
  };
  const poll = async () => {
    if (!active()) {
      stop();
      return;
    }
    try {
      const results = await execute('drain');
      deliver(results);
      if (!active()) {
        stop();
        return;
      }
      timer = setTimeout(() => {
        void poll();
      }, 250);
    } catch {
      signal('unavailable');
      stop();
    }
  };
  if (!active()) stop();
  else {
    const install = async () => {
      const tab = await chrome.tabs.get(tabId);
      if (!active()) return;
      if (!canReadPage(tab)) throw new Error('unavailable');
      const expected = await getPageDocument({ ...tab, id: tabId });
      if (!active()) return;
      await assertPageDocument(expected);
      if (!active()) return;
      documentId = expected.documentId;
      await execute('start');
    };
    void install()
      .then(() => {
        if (!active()) {
          stop();
          // The install may have completed after the first cleanup request.
          void execute('stop').catch(() => {});
          return;
        }
        void poll();
      })
      .catch(() => {
        signal('unavailable');
        stop();
      });
  }
  return stop;
}
