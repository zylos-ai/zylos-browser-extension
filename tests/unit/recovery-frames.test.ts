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
