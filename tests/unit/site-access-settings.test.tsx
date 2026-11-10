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
    const form = container.querySelector<HTMLDetailsElement>('.site-access-add')!;
    if (!form.open) form.querySelector('summary')!.click();
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
  state = { ...initialRemoteState, siteAccess: { grants: [], audit: [], defaults: [] } };
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

it('requires an explicit site and defaults to read-only access for one day', async () => {
  await render();
  expect(container.querySelector<HTMLDetailsElement>('.site-access-add')!.open).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  await submit();
  expect(change).not.toHaveBeenCalled();
  await setValue('#site-access-origin', 'https://example.com');
  await submit();
  expect(change).toHaveBeenCalledExactlyOnceWith({
    type: 'remote-site-access-grant',
    origin: 'https://example.com',
    matchType: 'origin',
    mode: 'read-only',
    durationMinutes: 1440,
  });
  expect(container.textContent).toContain('siteAccessReadOnlyHint');
  const form = container.querySelector<HTMLDetailsElement>('.site-access-add')!;
  expect(form.open).toBe(true);
  await act(async () => form.querySelector('summary')!.click());
  expect(form.open).toBe(false);
});

it('shows corrupted-rule recovery outside collapsed sections and resets only on explicit click', async () => {
  state.siteAccess!.recoveryRequired = true;
  await render();
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain('siteAccessRecoveryRequired');
  expect(alert.closest('details')).toBeNull();
  expect(change).not.toHaveBeenCalled();
  await act(async () => alert.querySelector<HTMLButtonElement>('button')!.click());
  expect(change).toHaveBeenCalledExactlyOnceWith({ type: 'remote-site-access-reset' });
});

it('makes action permission and duration explicit in the grant request', async () => {
  await render();
  await setValue('#site-access-origin', 'https://example.com:8443');
  await setValue('#site-access-mode', 'interactive');
  await setValue('#site-access-duration', '7');
  await submit();
  expect(change).toHaveBeenCalledExactlyOnceWith({
    type: 'remote-site-access-grant',
    origin: 'https://example.com:8443',
    matchType: 'origin',
    mode: 'interactive',
    durationMinutes: 10080,
  });
  expect(container.textContent).toContain('siteAccessInteractiveHint');
});

it('offers day durations and submits explicit permanent access without an expiry date', async () => {
  await render();
  expect(
    [...container.querySelectorAll('#site-access-duration option')].map(
      (option) => (option as HTMLOptionElement).value,
    ),
  ).toEqual(['1', '7', '30', 'permanent']);
  await setValue('#site-access-origin', 'https://example.com');
  await setValue('#site-access-duration', 'permanent');
  await submit();
  expect(change).toHaveBeenCalledExactlyOnceWith({
    type: 'remote-site-access-grant',
    origin: 'https://example.com',
    matchType: 'origin',
    mode: 'read-only',
    durationMinutes: null,
  });
  state.siteAccess!.grants = [
    {
      id: 'permanent',
      origin: 'https://example.com',
      mode: 'read-only',
      createdAt: Date.now(),
      expiresAt: null,
    },
  ];
  await render();
  const row = container.querySelector('.site-access-grant')!;
  expect(row.textContent).toContain('siteAccessPermanent');
  expect(row.querySelector('time')).toBeNull();
  expect(row.textContent).not.toContain('siteAccessExpired');
  await act(async () => row.querySelector<HTMLButtonElement>('button')!.click());
  expect(change).toHaveBeenLastCalledWith({ type: 'remote-site-access-revoke', id: 'permanent' });
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
  const list = container.querySelector<HTMLDetailsElement>('.site-access-list')!;
  expect(list.open).toBe(false);
  expect(list.querySelector('summary')!.textContent).toContain('(1)');
  await act(async () => list.querySelector('summary')!.click());
  expect(list.open).toBe(true);
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
  await act(async () => list.querySelector('summary')!.click());
  expect(list.open).toBe(false);
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

it.each([
  ['domain', '*.example.com', 'siteAccessDomainHint'],
  ['domain-regex', '^.*\\.example\\.com$', 'siteAccessRegexHint'],
])(
  'sends explicit %s matching and deny mode without interpreting the pattern in the panel',
  async (matchType, pattern, hint) => {
    await render();
    await setValue('#site-access-match-type', matchType);
    await setValue('#site-access-origin', pattern);
    await setValue('#site-access-mode', 'denied');
    await submit();
    expect(change).toHaveBeenCalledExactlyOnceWith({
      type: 'remote-site-access-grant',
      origin: pattern,
      matchType,
      mode: 'denied',
      durationMinutes: 1440,
    });
    expect(container.textContent).toContain(hint);
    expect(container.textContent).toContain('siteAccessBlockedHint');
    expect(container.querySelector<HTMLInputElement>('#site-access-origin')!.type).toBe('text');
  },
);

it('keeps default rules collapsed and sends explicit enabled and mode changes', async () => {
  state.siteAccess!.defaults = [
    {
      id: 'billing',
      label: 'Billing and checkout',
      kind: 'url-regex',
      pattern: '/billing',
      enabled: true,
      mode: 'denied',
    },
  ];
  await render();
  const list = container.querySelector<HTMLDetailsElement>('.site-access-defaults')!;
  expect(list.open).toBe(false);
  await act(async () => list.querySelector('summary')!.click());
  expect(list.open).toBe(true);
  expect(list.textContent).toContain('siteDefaultBilling');
  const checkbox = list.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => checkbox.click());
  expect(change).toHaveBeenLastCalledWith({
    type: 'remote-site-access-default',
    id: 'billing',
    enabled: false,
    mode: 'denied',
  });
  state.siteAccess!.defaults[0]!.enabled = false;
  await render();
  expect(checkbox.checked).toBe(false);
  await setValue('.site-access-default select', 'read-only');
  expect(change).toHaveBeenLastCalledWith({
    type: 'remote-site-access-default',
    id: 'billing',
    enabled: false,
    mode: 'read-only',
  });
  state.siteAccess!.defaults[0]!.mode = 'read-only';
  await render();
  expect(list.querySelector<HTMLSelectElement>('select')!.value).toBe('read-only');
});

it('disables default-rule controls while a mutation is pending', async () => {
  state.siteAccess!.defaults = [
    {
      id: 'billing',
      label: 'Billing and checkout',
      kind: 'url-regex',
      pattern: '/billing',
      enabled: true,
      mode: 'denied',
    },
  ];
  pending = true;
  await render();
  expect(container.querySelector<HTMLInputElement>('.site-access-default input')!.disabled).toBe(
    true,
  );
  expect(container.querySelector<HTMLSelectElement>('.site-access-default select')!.disabled).toBe(
    true,
  );
});
