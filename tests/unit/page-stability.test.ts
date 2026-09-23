// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  NetworkActivity,
  waitForStablePage,
  type PageProbe,
} from '../../utils/automation/page-stability';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());
const probe = (overrides: Partial<PageProbe> = {}): PageProbe => ({
  signature: 'initial',
  busy: false,
  atBoundary: false,
  limited: false,
  frames: ['main'],
  ...overrides,
});
const idle = () => ({ pending: 0, lastActivity: 0 });

it('returns a static page quickly without spending the full waiting budget', async () => {
  const work = waitForStablePage({
    probe: async () => probe(),
    network: idle,
    check() {},
    timeoutMs: 4000,
  });
  await vi.advanceTimersByTimeAsync(450);
  expect(await work).toMatchObject({
    status: 'stable',
    durationMs: 450,
    endOfContent: 'unconfirmed',
  });
});
it('waits for delayed loading, request completion and subsequent render changes', async () => {
  const work = waitForStablePage({
    probe: async () =>
      probe({
        signature: Date.now() < 1800 ? 'old' : 'new',
        atBoundary: true,
        busy: Date.now() >= 600 && Date.now() < 1800,
      }),
    network: () => ({
      pending: Date.now() >= 800 && Date.now() < 1500 ? 1 : 0,
      lastActivity: Date.now() < 800 ? 0 : Date.now() < 1500 ? 800 : 1500,
    }),
    check() {},
    timeoutMs: 4000,
    boundaryGrace: true,
  });
  await vi.advanceTimersByTimeAsync(2250);
  expect(await work).toMatchObject({
    status: 'stable',
    contentChangedDuringWait: true,
    durationMs: 2250,
  });
});
it('bounds perpetual requests, loading indicators and moving content', async () => {
  const work = waitForStablePage({
    probe: async () => probe({ busy: true, signature: String(Date.now()) }),
    network: () => ({ pending: 1, lastActivity: Date.now() }),
    check() {},
    timeoutMs: 1100,
  });
  await vi.advanceTimersByTimeAsync(1100);
  expect(await work).toMatchObject({ status: 'loading', durationMs: 1100, pendingRequests: 1 });
});
it('does not certify limited probes or silently swallow cancellation', async () => {
  const work = waitForStablePage({
    probe: async () => probe({ limited: true }),
    network: idle,
    check() {},
    timeoutMs: 4000,
  });
  await vi.advanceTimersByTimeAsync(450);
  expect(await work).toHaveProperty('status', 'partial');
  let active = true;
  const stopped = waitForStablePage({
    probe: async () => probe(),
    network: idle,
    check() {
      if (!active) throw Object.assign(new Error('stop'), { code: 'STOPPED' });
    },
    timeoutMs: 4000,
  });
  const assertion = expect(stopped).rejects.toMatchObject({ code: 'STOPPED' });
  active = false;
  await vi.advanceTimersByTimeAsync(150);
  await assertion;
});
it('tracks XHR/fetch until completion, scopes frames, ignores streams and clears identities', () => {
  const tracker = new NetworkActivity();
  tracker.event(
    '',
    'Network.requestWillBeSent',
    { requestId: 'x', frameId: 'main', type: 'XHR' },
    100,
  );
  tracker.event(
    'child',
    'Network.requestWillBeSent',
    { requestId: 'x', frameId: 'child', type: 'Fetch' },
    200,
  );
  tracker.event(
    '',
    'Network.requestWillBeSent',
    { requestId: 'video', frameId: 'main', type: 'Media' },
    300,
  );
  expect(tracker.sample(['main'], 400)).toEqual({ pending: 1, lastActivity: 100 });
  tracker.event('', 'Network.responseReceived', { requestId: 'x', type: 'XHR' }, 500);
  expect(tracker.sample(['main'], 500).pending).toBe(1);
  tracker.event('', 'Network.loadingFinished', { requestId: 'x' }, 700);
  expect(tracker.sample(['main'], 700)).toEqual({ pending: 0, lastActivity: 700 });
  expect(tracker.sample(['child'], 700).pending).toBe(1);
  tracker.clear();
  expect(tracker.sample(['main', 'child'])).toEqual({ pending: 0, lastActivity: 0 });
});
