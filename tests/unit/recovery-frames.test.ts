import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recoveryFrameScript } from '../../utils/automation/recovery-frames';

const ownId = 'a'.repeat(32);
const extensionId = 'b'.repeat(32);
const options = () => ({
  action: 'inspect' as const,
  recoveryId: crypto.randomUUID(),
  expiresAt: Date.now() + 120000,
  ownId,
  url: location.href,
  allowClosedShadow: true,
});
const iframe = (src: string, parent: ParentNode = document.body) => {
  const node = document.createElement('iframe');
  node.src = src;
  parent.appendChild(node);
  return node;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ allowed: true })) } });
});
afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as any).__zylosRecoveryFrames;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('inspects once, excludes normal/own/srcdoc frames and returns no paths or contents', async () => {
  const input = options();
  iframe(`chrome-extension://${extensionId}/private?secret=VALUE`);
  const own = iframe(`chrome-extension://${ownId}/private`);
  const normal = iframe('https://example.test/private');
  const inline = iframe(`chrome-extension://${extensionId}/ignored`);
  inline.srcdoc = '<input value="PRIVATE">';
  const host = document.createElement('div');
  document.body.append(host);
  iframe(`chrome-extension://${extensionId}/shadow`, host.attachShadow({ mode: 'open' }));
  const result = await recoveryFrameScript(input);
  expect(result.inspection?.candidates).toHaveLength(2);
  expect(result.inspection?.coverage).toBe('root-document-open-shadow');
  expect(JSON.stringify(result)).not.toMatch(/private|secret|VALUE|PRIVATE|\/shadow/);
  iframe(`chrome-extension://${extensionId}/later`);
  expect(await recoveryFrameScript(input)).toEqual(result);
  expect(own.isConnected && normal.isConnected && inline.isConnected).toBe(true);
});
it('removes only explicit selected identities once and leaves other extension frames', async () => {
  const input = options();
  const first = iframe(`chrome-extension://${extensionId}/first`);
  const second = iframe(`chrome-extension://${extensionId}/second`);
  const result = await recoveryFrameScript(input);
  const selected = [result.inspection!.candidates[0]!.id];
  expect(
    await recoveryFrameScript({ ...input, action: 'remove', selected, nonce: 'nonce' }),
  ).toEqual({ removed: 1 });
  expect(first.isConnected).toBe(false);
  expect(second.isConnected).toBe(true);
  expect(
    await recoveryFrameScript({ ...input, action: 'remove', selected, nonce: 'nonce' }),
  ).toHaveProperty('error');
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
});
it.each(['src', 'srcdoc', 'replacement', 'unknown', 'duplicate'])(
  'fails all selected removal for %s candidates',
  async (change) => {
    const input = options();
    const first = iframe(`chrome-extension://${extensionId}/first`);
    const second = iframe(`chrome-extension://${extensionId}/second`);
    const result = await recoveryFrameScript(input);
    let selected = result.inspection!.candidates.map((candidate) => candidate.id);
    if (change === 'src') second.src = `chrome-extension://${extensionId}/changed`;
    if (change === 'srcdoc') second.srcdoc = '<p>changed</p>';
    if (change === 'replacement') second.replaceWith(second.cloneNode());
    if (change === 'unknown') selected[1] = crypto.randomUUID();
    if (change === 'duplicate') selected = [selected[0]!, selected[0]!];
    expect(
      await recoveryFrameScript({ ...input, action: 'remove', selected, nonce: 'nonce' }),
    ).toHaveProperty('error');
    expect(first.isConnected).toBe(true);
    expect(document.querySelectorAll('iframe')).toHaveLength(2);
  },
);
it.each(['revoke', 'expiry', 'denied'])(
  'does not remove if %s happens during authorization',
  async (change) => {
    const input = options();
    const node = iframe(`chrome-extension://${extensionId}/first`);
    const result = await recoveryFrameScript(input);
    let authorize!: (value: { allowed: boolean }) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          authorize = resolve;
        }),
    );
    const pending = recoveryFrameScript({
      ...input,
      action: 'remove',
      selected: [result.inspection!.candidates[0]!.id],
      nonce: 'nonce',
    });
    if (change === 'revoke') await recoveryFrameScript({ ...input, action: 'revoke' });
    if (change === 'expiry') vi.setSystemTime(input.expiresAt);
    authorize({ allowed: change !== 'denied' });
    expect(await pending).toHaveProperty('error');
    expect(node.isConnected).toBe(true);
  },
);
it('bounds candidate storage and reports truncation without deleting anything', async () => {
  for (let i = 0; i < 25; i++) iframe(`chrome-extension://${extensionId}/${i}`);
  const result = await recoveryFrameScript(options());
  expect(result.inspection?.candidates).toHaveLength(16);
  expect(result.inspection?.truncated).toBe(true);
  expect(document.querySelectorAll('iframe')).toHaveLength(25);
});

it('discovers nested closed roots and preserves exclusions and selected identity checks', async () => {
  const roots = new Map<Element, ShadowRoot>();
  (chrome as any).dom = {
    openOrClosedShadowRoot: (node: Element) => roots.get(node) ?? node.shadowRoot,
  };
  const outer = document.createElement('div');
  document.body.append(outer);
  const root = outer.attachShadow({ mode: 'closed' });
  roots.set(outer, root);
  const nested = document.createElement('div');
  root.append(nested);
  const inner = nested.attachShadow({ mode: 'closed' });
  roots.set(nested, inner);
  const foreign = iframe(`chrome-extension://${extensionId}/private`, inner);
  const own = iframe(`chrome-extension://${ownId}/private`, inner);
  const http = iframe('https://example.test/', inner);
  const inline = iframe(`chrome-extension://${extensionId}/inline`, inner);
  inline.srcdoc = '<p>control</p>';
  const input = options();
  const result = await recoveryFrameScript(input);
  expect(result.inspection?.coverage).toBe('root-document-open-and-closed-shadow');
  expect(result.inspection?.candidates).toHaveLength(1);
  expect(foreign.isConnected).toBe(true);
  expect(
    await recoveryFrameScript({
      ...input,
      action: 'remove',
      selected: [result.inspection!.candidates[0]!.id],
      nonce: 'nonce',
    }),
  ).toEqual({ removed: 1 });
  expect(foreign.isConnected).toBe(false);
  expect(own.isConnected && http.isConnected && inline.isConnected).toBe(true);
});

it('reports incomplete broad coverage when privileged shadow inspection throws', async () => {
  (chrome as any).dom = {
    openOrClosedShadowRoot: () => {
      throw new Error('unavailable');
    },
  };
  const host = document.createElement('div');
  document.body.append(host);
  iframe(`chrome-extension://${extensionId}/open`, host.attachShadow({ mode: 'open' }));
  const result = await recoveryFrameScript(options());
  expect(result.inspection?.coverage).toBe('root-document-open-and-closed-shadow');
  expect(result.inspection?.truncated).toBe(true);
  expect(result.inspection?.candidates).toHaveLength(1);
});

it.each([false, undefined])(
  'uses only open roots when closed-root support is %s',
  async (allowClosedShadow) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'closed' });
    const access = vi.fn((node: Element) => (node === host ? root : node.shadowRoot));
    (chrome as any).dom = { openOrClosedShadowRoot: access };
    iframe(`chrome-extension://${extensionId}/closed`, root);
    iframe(`chrome-extension://${extensionId}/light`);
    const result = await recoveryFrameScript({ ...options(), allowClosedShadow });
    expect(result.inspection?.coverage).toBe('root-document-open-shadow');
    expect(result.inspection?.candidates).toHaveLength(1);
    expect(result.inspection?.truncated).toBe(false);
    expect(access).not.toHaveBeenCalled();
  },
);

it('retains broad coverage if privileged inspection fails after finding a closed-root candidate', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  const frame = iframe(`chrome-extension://${extensionId}/closed`, root);
  (chrome as any).dom = {
    openOrClosedShadowRoot: (node: Element) => {
      if (node === frame) throw new Error('access lost');
      return node === host ? root : node.shadowRoot;
    },
  };
  const result = await recoveryFrameScript(options());
  expect(result.inspection?.coverage).toBe('root-document-open-and-closed-shadow');
  expect(result.inspection?.candidates).toHaveLength(1);
  expect(result.inspection?.truncated).toBe(true);
});

it('rejects replaced closed-root candidates without removing their replacements', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  (chrome as any).dom = {
    openOrClosedShadowRoot: (node: Element) => (node === host ? root : node.shadowRoot),
  };
  const original = iframe(`chrome-extension://${extensionId}/frame`, root);
  const input = options();
  const inspected = await recoveryFrameScript(input);
  const replacement = original.cloneNode();
  original.replaceWith(replacement);
  expect(
    await recoveryFrameScript({
      ...input,
      action: 'remove',
      selected: [inspected.inspection!.candidates[0]!.id],
      nonce: 'nonce',
    }),
  ).toEqual({ error: 'RECOVERY_CANDIDATE_CHANGED' });
  expect(replacement.isConnected).toBe(true);
});
it('finds a closed-root extension frame after SVG content, as Chrome rejects non-HTML elements', async () => {
  const closedRoots = new WeakMap<Element, ShadowRoot>();
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async () => ({ allowed: true })) },
    dom: {
      openOrClosedShadowRoot: (element: Element) => {
        if (!(element instanceof HTMLElement))
          throw new Error('Error in invocation of dom.openOrClosedShadowRoot(HTMLElement element)');
        return closedRoots.get(element) ?? element.shadowRoot;
      },
    },
  });
  document.body.innerHTML = '<svg><g><path></path></g></svg><svg></svg>';
  // 1Password-style: a custom host at the end of body, closed root, extension iframe.
  const host = document.createElement('com-1password-menu');
  const root = host.attachShadow({ mode: 'closed' });
  closedRoots.set(host, root);
  document.body.append(host);
  iframe(`chrome-extension://${extensionId}/inline/menu/menu.html`, root);
  const result = await recoveryFrameScript(options());
  expect(result.inspection).toMatchObject({
    truncated: false,
    coverage: 'root-document-open-and-closed-shadow',
  });
  expect(result.inspection?.candidates).toHaveLength(1);
  const probe = await recoveryFrameScript({ ...options(), action: 'probe' });
  expect(probe.inspection?.candidates).toHaveLength(1);
  expect((globalThis as any).__zylosRecoveryFrames.size).toBe(1);
});
