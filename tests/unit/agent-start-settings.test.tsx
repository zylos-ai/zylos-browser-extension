import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentStartSettings } from '../../components/AgentStartSettings';
import { initialRemoteState, type RemoteState } from '../../utils/remote';

vi.mock('../../components/LanguageProvider', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string, params?: Record<string, string>) =>
      params?.time ? `${key}: ${params.time}` : key,
  }),
}));

let root: Root, container: HTMLDivElement, state: RemoteState;
let change: ReturnType<typeof vi.fn<(enabled: boolean, durationMinutes?: number | null) => void>>;
let pending = false;
const render = () =>
  act(async () => {
    root.render(<AgentStartSettings state={state} pending={pending} onChange={change} />);
  });
const toggle = () =>
  act(async () => container.querySelector<HTMLButtonElement>('#agent-start-enabled')!.click());
async function choose(value: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('#agent-start-duration')!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state = { ...initialRemoteState, connected: true };
  pending = false;
  change = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('offers site-rule durations and enables for seven days by default', async () => {
  await render();
  expect(
    [...container.querySelectorAll('#agent-start-duration option')].map(
      (option) => (option as HTMLOptionElement).value,
    ),
  ).toEqual(['1', '7', '30', 'permanent']);
  expect(container.querySelector<HTMLSelectElement>('#agent-start-duration')!.value).toBe('7');
  await toggle();
  expect(change).toHaveBeenCalledExactlyOnceWith(true, 10080);
});

it('submits one day, thirty days or until turned off', async () => {
  await render();
  await choose('1');
  await toggle();
  await choose('30');
  await toggle();
  await choose('permanent');
  await toggle();
  expect(change.mock.calls).toEqual([
    [true, 1440],
    [true, 43200],
    [true, null],
  ]);
});

it('shows expiry with quick revoke while granted', async () => {
  const expiresAt = Date.UTC(2026, 10, 19, 8);
  state = { ...state, agentStartEnabled: true, agentStartExpiresAt: expiresAt };
  await render();
  expect(container.querySelector('#agent-start-duration')).toBeNull();
  const status = container.querySelector('#agent-start-expiry')!;
  expect(status.textContent).toContain('agentStartAllowedUntil');
  expect(status.querySelector('time')!.getAttribute('dateTime')).toBe(
    new Date(expiresAt).toISOString(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.agent-start-status button')!.click(),
  );
  await toggle();
  expect(change.mock.calls).toEqual([[false], [false]]);
});

it('shows a permanent grant as allowed until turned off', async () => {
  state = { ...state, agentStartEnabled: true, agentStartExpiresAt: null };
  await render();
  const status = container.querySelector('#agent-start-expiry')!;
  expect(status.textContent).toBe('agentStartAllowedUntilOff');
  expect(status.querySelector('time')).toBeNull();
});

it('cannot be enabled while disconnected but can still be revoked', async () => {
  state = { ...state, connected: false };
  await render();
  expect(container.querySelector<HTMLButtonElement>('#agent-start-enabled')!.disabled).toBe(true);
  expect(container.querySelector<HTMLSelectElement>('#agent-start-duration')!.disabled).toBe(true);
  state = { ...state, agentStartEnabled: true, agentStartExpiresAt: null };
  await render();
  expect(container.querySelector<HTMLButtonElement>('#agent-start-enabled')!.disabled).toBe(false);
});
