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
it('downloads a fresh immutable snapshot directly and keeps its details collapsed', async () => {
  await render();
  expect(send).not.toHaveBeenCalled();
  expect(container.querySelector('#detailed-download')).not.toBeNull();
  expect(container.querySelector<HTMLDetailsElement>('#detailed-preview')!.open).toBe(false);
  await press('#detailed-download');
  // WebCrypto completes outside React's synchronous event callback.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const text = container.querySelector<HTMLTextAreaElement>('#detailed-preview-text')!.value;
  expect(await downloaded!.text()).toBe(text);
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(text))).toString(
    'hex',
  );
  expect(container.textContent).toContain(hash);
  expect(container.querySelector('.detailed-hash')!.closest('details')!.open).toBe(false);
  expect(click).toHaveBeenCalledOnce();
  expect(send.mock.calls.map(([message]) => message.type)).toEqual([
    'remote-detailed-preview',
    'remote-detailed-validate',
  ]);
  await press('#detailed-preview > summary');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(container.querySelector<HTMLDetailsElement>('#detailed-preview')!.open).toBe(true);
  await press('#detailed-preview > summary');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(container.querySelector<HTMLDetailsElement>('#detailed-preview')!.open).toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
});

it('offers retained fault export and explicit clear while live capture is off', async () => {
  state.detailedDiagnostics = {
    ...state.detailedDiagnostics!,
    enabled: false,
    consent: '',
    expiresAt: 0,
    count: 0,
    exportConsent: 'frozen-export',
    exportExpiresAt: Date.now() + 86400000,
    frozenAt: Date.now(),
    frozenCount: 1,
  };
  await render();
  expect(container.querySelector('#detailed-enabled')?.getAttribute('aria-checked')).toBe('false');
  expect(container.querySelector('#detailed-frozen')?.textContent).toContain(
    'detailedFrozenExpires',
  );
  await press('#detailed-download');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(send).toHaveBeenCalledWith({ type: 'remote-detailed-preview', consent: 'frozen-export' });
  expect(click).toHaveBeenCalledOnce();
  await press('#detailed-clear');
  expect(send).toHaveBeenCalledWith({ type: 'remote-detailed-set-enabled', enabled: false });
  expect(toggle).not.toHaveBeenCalled();
});
it('allows immediate opt-out during a delayed direct download and discards its stale result', async () => {
  let resolve!: (value: unknown) => void;
  send.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await press('#detailed-download');
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
  let resolve!: (value: unknown) => void;
  send.mockImplementation((message) =>
    message.type === 'remote-detailed-preview'
      ? Promise.resolve({ ok: true, value: payload })
      : new Promise((done) => {
          resolve = done;
        }),
  );
  await render();
  await press('#detailed-download');
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
  state = {
    ...state,
    detailedDiagnostics: { ...state.detailedDiagnostics!, enabled: false, consent: '' },
  };
  await render();
  await act(async () => resolve({ ok: true, value: { valid: true } }));
  expect(click).not.toHaveBeenCalled();
  expect(container.querySelector('#detailed-preview-text')).toBeNull();
});

it('shows no detailed logs for an empty capture but still downloads useful metadata', async () => {
  state = { ...state, detailedDiagnostics: { ...state.detailedDiagnostics!, count: 0 } };
  send.mockImplementation(async (message) => ({
    ok: true,
    value:
      message.type === 'remote-detailed-preview'
        ? { schemaVersion: 2, capture: { records: [] }, incidents: [{ trigger: 'control-loss' }] }
        : { valid: true },
  }));
  await render();
  expect(container.textContent).toContain('detailedEmpty');
  expect(container.querySelector('#detailed-preview')).toBeNull();
  await press('#detailed-download');
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(JSON.parse(await downloaded!.text()).incidents).toHaveLength(1);
  expect(container.querySelector('#detailed-preview-text')).toBeNull();
});

it('each direct download refreshes the snapshot rather than exporting a stale earlier capture', async () => {
  await render();
  await press('#detailed-download');
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
  const first = await downloaded!.text();
  const newer = { ...payload, records: [{ text: 'new capture' }] };
  send.mockImplementation(async (message) => ({
    ok: true,
    value: message.type === 'remote-detailed-preview' ? newer : { valid: true },
  }));
  await press('#detailed-download');
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(await downloaded!.text()).not.toBe(first);
  expect(await downloaded!.text()).toBe(JSON.stringify(newer, null, 2));
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
  expect(container.querySelector<HTMLDetailsElement>('#detail-share-details')!.open).toBe(false);
  expect(send.mock.calls.some(([message]) => message.type === 'remote-detail-share-grant')).toBe(
    false,
  );
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

it('preparing another sharing snapshot resets consent and collapses details', async () => {
  state = { ...state, connected: true, relayUrl: 'wss://remote.example/ext' };
  send.mockResolvedValue({ ok: true, value: shared });
  await render();
  await press('#detail-share-prepare');
  await press('#detail-share-consent');
  await press('#detail-share-details > summary');
  await act(async () => {
    await new Promise((done) => setTimeout(done, 10));
  });
  expect(container.querySelector<HTMLDetailsElement>('#detail-share-details')!.open).toBe(true);
  const newer = {
    ...shared,
    id: '33333333-3333-4333-8333-333333333333',
    text: 'new frozen snapshot',
  };
  send.mockResolvedValue({ ok: true, value: newer });
  await press('#detail-share-prepare');
  expect(container.querySelector<HTMLInputElement>('#detail-share-consent')!.checked).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('#detail-share-grant')!.disabled).toBe(true);
  expect(container.querySelector<HTMLDetailsElement>('#detail-share-details')!.open).toBe(false);
  await press('#detail-share-consent');
  await press('#detail-share-grant');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-detail-share-grant', id: newer.id });
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
  expect(container.querySelector<HTMLButtonElement>('#detail-share-prepare')!.disabled).toBe(false);
});

it('a stale sharing request cannot unlock a new pending request after the recipient changes', async () => {
  state = { ...state, connected: true, relayUrl: 'wss://remote.example/ext' };
  const replies: ((value: unknown) => void)[] = [];
  send.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
  await render();
  await press('#detail-share-prepare');
  state = { ...state, relayUrl: 'wss://other.example/ext' };
  await render();
  await press('#detail-share-prepare');
  await act(async () => replies[0]!({ ok: true, value: shared }));
  expect(container.querySelector<HTMLButtonElement>('#detail-share-prepare')!.disabled).toBe(true);
  expect(container.querySelector('#detail-share-consent')).toBeNull();
  await act(async () =>
    replies[1]!({ ok: true, value: { ...shared, recipient: 'wss://other.example' } }),
  );
  expect(container.querySelector<HTMLButtonElement>('#detail-share-prepare')!.disabled).toBe(false);
  expect(container.textContent).toContain('wss://other.example');
});

it('opt-out invalidates a delayed download even before updated props arrive', async () => {
  let complete!: (value: unknown) => void;
  send.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  await press('#detailed-download');
  await press('#detailed-enabled');
  await render();
  await act(async () => {
    complete({ ok: true, value: payload });
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(click).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
});

it('an empty prepared snapshot still requires consent but does not display empty JSON', async () => {
  state = { ...state, connected: true, relayUrl: 'wss://remote.example/ext' };
  const empty = {
    ...shared,
    text: JSON.stringify({ schemaVersion: 2, capture: { records: [] }, incidents: [] }),
  };
  send.mockResolvedValue({ ok: true, value: empty });
  await render();
  await press('#detail-share-prepare');
  expect(container.querySelector('#detail-share-details')).toBeNull();
  expect(container.querySelector('#detail-share-text')).toBeNull();
  expect(container.textContent).toContain('detailedEmpty');
  expect(container.querySelector<HTMLInputElement>('#detail-share-consent')!.checked).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('#detail-share-grant')!.disabled).toBe(true);
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
