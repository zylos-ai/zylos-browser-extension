import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SiteAccessSettings } from '../../components/SiteAccessSettings';
import { initialRemoteState, type RemoteRequest, type RemoteState } from '../../utils/remote';

vi.mock('../../components/LanguageProvider', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string, params?: Record<string, string>) =>
      params?.origin ? `${key}: ${params.origin}` : key,
  }),
}));

let root: Root, container: HTMLDivElement, state: RemoteState;
let change: ReturnType<typeof vi.fn<(request: RemoteRequest) => void>>;
let pending = false;
const render = () =>
  act(async () => {
    root.render(<SiteAccessSettings state={state} pending={pending} onChange={change} />);
  });
async function setValue(selector: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
const submit = () =>
  act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state = { ...initialRemoteState, siteAccess: { grants: [], audit: [] } };
  pending = false;
  change = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('requires an explicit site and defaults to read-only access for fifteen minutes', async () => {
  await render();
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  await submit();
  expect(change).not.toHaveBeenCalled();
  await setValue('#site-access-origin', 'https://example.com');
  await submit();
  expect(change).toHaveBeenCalledExactlyOnceWith({
    type: 'remote-site-access-grant',
    origin: 'https://example.com',
    mode: 'read-only',
    durationMinutes: 15,
  });
  expect(container.textContent).toContain('siteAccessReadOnlyHint');
});

it('makes action permission and duration explicit in the grant request', async () => {
  await render();
  await setValue('#site-access-origin', 'https://example.com:8443');
  await setValue('#site-access-mode', 'interactive');
  await setValue('#site-access-duration', '60');
  await submit();
  expect(change).toHaveBeenCalledExactlyOnceWith({
    type: 'remote-site-access-grant',
    origin: 'https://example.com:8443',
    mode: 'interactive',
    durationMinutes: 60,
  });
  expect(container.textContent).toContain('siteAccessInteractiveHint');
});

it('shows scope, current expiry and revoke for an existing grant', async () => {
  const expiresAt = Date.now() + 60_000;
  state.siteAccess!.grants = [
    {
      id: 'grant-1',
      origin: 'https://example.com',
      mode: 'read-only',
      createdAt: Date.now(),
      expiresAt,
    },
  ];
  await render();
  expect(container.querySelector('.site-access-grant')!.textContent).toContain(
    'https://example.com',
  );
  expect(container.querySelector('.site-access-grant time')!.getAttribute('datetime')).toBe(
    new Date(expiresAt).toISOString(),
  );
  await act(async () => container.querySelector<HTMLButtonElement>('.site-access-revoke')!.click());
  expect(change).toHaveBeenCalledExactlyOnceWith({
    type: 'remote-site-access-revoke',
    id: 'grant-1',
  });
});

it('marks a grant expired without waiting for a background state push', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  state.siteAccess!.grants = [
    {
      id: 'grant-1',
      origin: 'https://example.com',
      mode: 'interactive',
      createdAt: now,
      expiresAt: now + 1500,
    },
  ];
  await render();
  expect(container.querySelector('.site-access-grant')!.textContent).toContain('siteAccessExpires');
  await act(async () => vi.advanceTimersByTime(2000));
  expect(container.querySelector('.site-access-grant')!.textContent).toContain('siteAccessExpired');
});

it('shows recent audit events newest first and disables mutation while pending', async () => {
  state.siteAccess!.audit = [
    {
      id: 'older',
      at: Date.now() - 1000,
      origin: 'https://old.example',
      action: 'read-page',
      allowed: true,
      mode: 'read-only',
    },
    { id: 'newer', at: Date.now(), origin: 'https://new.example', action: 'click', allowed: false },
  ];
  pending = true;
  await render();
  const events = container.querySelectorAll('.site-access-event');
  expect(events[0]!.textContent).toContain('https://new.example');
  expect(events[0]!.textContent).toContain('siteAccessDenied');
  expect(events[1]!.textContent).toContain('siteAccessAllowed');
  expect(container.querySelector<HTMLInputElement>('#site-access-origin')!.disabled).toBe(true);
  await submit();
  expect(change).not.toHaveBeenCalled();
});
