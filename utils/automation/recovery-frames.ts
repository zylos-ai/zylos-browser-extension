export type RecoveryFrameInspection = {
  candidates: { id: string; extensionOrigin: string }[];
  truncated: boolean;
  coverage:
    | 'root-document-open-shadow'
    | 'root-document-open-and-closed-shadow'
    | 'documents-open-and-closed-shadow';
};

/** Serialized into the isolated world. Never reads iframe contents or exports src paths. */
export async function recoveryFrameScript(options: {
  action: 'inspect' | 'probe' | 'remove' | 'revoke';
  recoveryId: string;
  expiresAt: number;
  ownId: string;
  url: string;
  allowClosedShadow?: boolean;
  selected?: string[];
  nonce?: string;
}): Promise<{ inspection?: RecoveryFrameInspection; removed?: number; error?: string }> {
  type Candidate = {
    node: HTMLIFrameElement;
    src: string;
    href: string;
    id: string;
    extensionOrigin: string;
  };
  type Stored = {
    candidates: Candidate[];
    inspection: RecoveryFrameInspection;
    expiresAt: number;
    used: boolean;
  };
  const host = globalThis as typeof globalThis & { __zylosRecoveryFrames?: Map<string, Stored> };
  const entries: Map<string, Stored> = (host.__zylosRecoveryFrames ??= new Map<string, Stored>());
  if (options.action === 'revoke') {
    entries.delete(options.recoveryId);
    return {};
  }
  const valid = () => Date.now() < options.expiresAt && location.href === options.url;
  if (!valid()) return { error: 'RECOVERY_UNAVAILABLE' };
  const foreign = (node: HTMLIFrameElement) => {
    if (node.hasAttribute('srcdoc')) return undefined;
    try {
      const url = new URL(node.getAttribute('src') || '', document.baseURI);
      if (
        url.protocol !== 'chrome-extension:' ||
        !/^[a-p]{32}$/.test(url.hostname) ||
        url.hostname === options.ownId ||
        url.username ||
        url.password
      )
        return undefined;
      return { href: url.href, origin: `chrome-extension://${url.hostname}` };
    } catch {
      return undefined;
    }
  };
  // A probe reports presence only; it never replaces the retained inspection snapshot.
  if (options.action === 'inspect' || options.action === 'probe') {
    const saved = options.action === 'inspect' ? entries.get(options.recoveryId) : undefined;
    if (saved) return { inspection: saved.inspection };
    if (options.action === 'inspect') entries.clear();
    const candidates: Candidate[] = [];
    const dom = (
      chrome as typeof chrome & {
        dom?: { openOrClosedShadowRoot?: (element: Element) => ShadowRoot | null };
      }
    ).dom;
    const closedShadowCovered =
      options.allowClosedShadow === true && typeof dom?.openOrClosedShadowRoot === 'function';
    let shadowAccessFailed = false;
    // The API accepts only HTMLElement (an SVG element throws), so the check is per node:
    // one unsupported element must not disable closed-root coverage for the rest.
    const shadowRoot = (node: Element) => {
      if (closedShadowCovered && node instanceof HTMLElement) {
        try {
          return dom!.openOrClosedShadowRoot!(node);
        } catch {
          shadowAccessFailed = true;
        }
      }
      return node.shadowRoot;
    };
    let visited = 0,
      truncated = false;
    const started = performance.now();
    const visit = (root: ParentNode, depth: number) => {
      if (depth > 32) {
        truncated = true;
        return;
      }
      for (let node = root.firstElementChild; node; node = node.nextElementSibling) {
        if (++visited > 10000 || performance.now() - started > 100 || candidates.length >= 16) {
          truncated = true;
          return;
        }
        if (node instanceof HTMLIFrameElement) {
          const url = foreign(node);
          if (url)
            candidates.push({
              node,
              src: node.getAttribute('src')!,
              href: url.href,
              id: crypto.randomUUID(),
              extensionOrigin: url.origin,
            });
        }
        const shadow = shadowRoot(node);
        if (shadow) visit(shadow, depth + 1);
        visit(node, depth + 1);
        if (truncated) return;
      }
    };
    visit(document, 0);
    const inspection: RecoveryFrameInspection = {
      candidates: candidates.map(({ id, extensionOrigin }) => ({ id, extensionOrigin })),
      truncated:
        truncated ||
        shadowAccessFailed ||
        (options.allowClosedShadow === true && !closedShadowCovered),
      coverage: closedShadowCovered
        ? 'root-document-open-and-closed-shadow'
        : 'root-document-open-shadow',
    };
    if (options.action === 'probe') return { inspection };
    const stored = { candidates, inspection, expiresAt: options.expiresAt, used: false };
    entries.set(options.recoveryId, stored);
    setTimeout(
      () => {
        if (entries.get(options.recoveryId) === stored) entries.delete(options.recoveryId);
      },
      Math.max(0, options.expiresAt - Date.now()),
    );
    return { inspection };
  }
  const saved = entries.get(options.recoveryId);
  if (
    !saved ||
    saved.used ||
    Date.now() >= saved.expiresAt ||
    !options.selected?.length ||
    options.selected.length > 16 ||
    new Set(options.selected).size !== options.selected.length
  )
    return { error: 'RECOVERY_UNAVAILABLE' };
  const authorized = await chrome.runtime.sendMessage({
    type: 'recovery-frame-authorize',
    recoveryId: options.recoveryId,
    nonce: options.nonce,
  });
  if (
    authorized?.allowed !== true ||
    !valid() ||
    entries.get(options.recoveryId) !== saved ||
    saved.used
  )
    return { error: 'RECOVERY_UNAVAILABLE' };
  saved.used = true;
  const selected = options.selected.map((id) =>
    saved.candidates.find((candidate) => candidate.id === id),
  );
  if (
    selected.some(
      (candidate) =>
        !candidate ||
        !candidate.node.isConnected ||
        candidate.node.ownerDocument !== document ||
        candidate.node.getRootNode({ composed: true }) !== document ||
        candidate.node.getAttribute('src') !== candidate.src ||
        foreign(candidate.node)?.href !== candidate.href,
    )
  )
    return { error: 'RECOVERY_CANDIDATE_CHANGED' };
  for (const candidate of selected) candidate!.node.remove();
  entries.delete(options.recoveryId);
  return { removed: selected.length };
}
