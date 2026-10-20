import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { DetailedDiagnosticsSettings } from '../../components/DetailedDiagnosticsSettings';
import { initialRemoteState, type RemoteState } from '../../utils/remote';
vi.mock('../../components/LanguageProvider', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
let root: Root, container: HTMLDivElement, state: RemoteState;
let send: ReturnType<typeof vi.fn>,
  toggle: ReturnType<typeof vi.fn<() => void>>,
  click: ReturnType<typeof vi.spyOn>;
let downloaded: NodeBlob | undefined;
const payload = { schemaVersion: 1, records: [{ text: 'review this exact text' }], partial: true };
const render = () =>
  act(async () => {
    root.render(<DetailedDiagnosticsSettings state={state} pending={false} onToggle={toggle} />);
  });
const press = (id: string) =>
  act(async () => {
    container.querySelector<HTMLButtonElement>(id)!.click();
  });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Blob', NodeBlob);
  state = {
    ...initialRemoteState,
    detailedDiagnostics: {
      enabled: true,
      consent: '11111111-1111-4111-8111-111111111111',
      expiresAt: Date.now() + 600000,
      count: 1,
      bytes: 10,
      dropped: 0,
      truncated: 0,
    },
  };
  send = vi.fn(async (message) => ({
    ok: true,
    value: message.type === 'remote-detailed-preview' ? payload : { valid: true },
  }));
  toggle = vi.fn();
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  downloaded = undefined;
  URL.createObjectURL = vi.fn((blob) => {
    downloaded = blob as unknown as NodeBlob;
    return 'blob:download';
  });
  URL.revokeObjectURL = vi.fn();
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('requires an explicit preview before downloading exact reviewed bytes and their hash', async () => {
  await render();
  expect(send).not.toHaveBeenCalled();
  expect(container.querySelector('#detailed-download')).toBeNull();
  await press('#detailed-preview');
  // WebCrypto completes outside React's synchronous event callback.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const text = container.querySelector<HTMLTextAreaElement>('#detailed-preview-text')!.value;
  await press('#detailed-download');
  expect(await downloaded!.text()).toBe(text);
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(text))).toString(
    'hex',
  );
  expect(container.textContent).toContain(hash);
  expect(click).toHaveBeenCalledOnce();
  expect(send.mock.calls.map(([message]) => message.type)).toEqual([
    'remote-detailed-preview',
    'remote-detailed-validate',
  ]);
});
it('allows immediate opt-out during a delayed preview and discards its stale result', async () => {
  let resolve!: (value: unknown) => void;
  send.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await press('#detailed-preview');
  expect(container.querySelector<HTMLButtonElement>('#detailed-enabled')!.disabled).toBe(false);
  await press('#detailed-enabled');
  expect(toggle).toHaveBeenCalledOnce();
  state = {
    ...state,
    detailedDiagnostics: { ...state.detailedDiagnostics!, enabled: false, consent: '' },
  };
  await render();
  await act(async () => {
    resolve({ ok: true, value: payload });
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(container.querySelector('#detailed-preview-text')).toBeNull();
  expect(click).not.toHaveBeenCalled();
});
it('revocation while export validation is pending prevents the download', async () => {
  await render();
  await press('#detailed-preview');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  let resolve!: (value: unknown) => void;
  send.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await press('#detailed-download');
  state = {
    ...state,
    detailedDiagnostics: { ...state.detailedDiagnostics!, enabled: false, consent: '' },
  };
  await render();
  await act(async () => resolve({ ok: true, value: { valid: true } }));
  expect(click).not.toHaveBeenCalled();
  expect(container.querySelector('#detailed-preview-text')).toBeNull();
});

const shared = {
  id: '22222222-2222-4222-8222-222222222222',
  text: 'exact shared snapshot',
  sha256: 'a'.repeat(64),
  recipient: 'wss://remote.example',
  expiresAt: Date.now() + 120000,
};
it('requires unchecked local consent and reflects consumed status without stale authorization', async () => {
  state = { ...state, connected: true, relayUrl: 'wss://remote.example/ext' };
  send.mockResolvedValue({ ok: true, value: shared });
  await render();
  await press('#detail-share-prepare');
  expect(container.querySelector<HTMLTextAreaElement>('#detail-share-text')!.value).toBe(
    shared.text,
  );
  expect(container.querySelector<HTMLInputElement>('#detail-share-consent')!.checked).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('#detail-share-grant')!.disabled).toBe(true);
  await press('#detail-share-consent');
  let complete!: (value: unknown) => void;
  send.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await press('#detail-share-grant');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-detail-share-grant', id: shared.id });
  state = { ...state, detailedSharing: { phase: 'consumed', expiresAt: shared.expiresAt } };
  await render();
  await act(async () => complete({ ok: true, value: { expiresAt: shared.expiresAt } }));
  expect(container.textContent).toContain('detailShareConsumed');
  expect(container.textContent).not.toContain('detailShareAuthorized');
  expect(container.querySelector('#detail-share-text')).toBeNull();
});
it('discards delayed shared preview after recipient changes', async () => {
  state = { ...state, connected: true, relayUrl: 'wss://remote.example/ext' };
  let complete!: (value: unknown) => void;
  send.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  await press('#detail-share-prepare');
  state = { ...state, relayUrl: 'wss://other.example/ext' };
  await render();
  await act(async () => complete({ ok: true, value: shared }));
  expect(container.querySelector('#detail-share-text')).toBeNull();
  expect(container.querySelector('#detail-share-grant')).toBeNull();
});
it('a fresh panel can revoke an existing grant without preparing another snapshot', async () => {
  state = {
    ...state,
    connected: true,
    relayUrl: 'wss://remote.example/ext',
    detailedSharing: { phase: 'authorized', expiresAt: shared.expiresAt },
  };
  await render();
  expect(container.querySelector('#detail-share-text')).toBeNull();
  await press('#detail-share-revoke');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-detail-share-revoke' });
  state = { ...state, detailedSharing: { phase: 'revoked', expiresAt: shared.expiresAt } };
  await render();
  expect(container.textContent).toContain('detailShareRevoked');
  expect(container.querySelector('#detail-share-revoke')).toBeNull();
});
