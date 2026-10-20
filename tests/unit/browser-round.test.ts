// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const executor = vi.hoisted(() => ({
  currentControl: vi.fn(),
  currentGrant: vi.fn(),
  browserPageVersion: vi.fn(),
  flushTaskPopups: vi.fn(async () => {}),
  taskPopupOpener: vi.fn(),
  controlLossRevision: vi.fn(),
}));
vi.mock('../../utils/automation/executor', () => executor);
import { runBrowserRound } from '../../utils/browser-round';
import { BrowserLoop, type AgentRequest } from '../../utils/browser-loop';

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  executor.currentControl.mockReturnValue({ sessionId: 'task', tabId: 1, tabIds: [1] });
  executor.currentGrant.mockReturnValue({ id: 1, url: 'https://example.com' });
  executor.browserPageVersion.mockReturnValue('task:1:1');
  executor.controlLossRevision.mockReturnValue(0);
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: 'https://example.com', status: 'complete' })),
    },
  });
});

it.each(['snapshot', 'after-fill', 'during-fill', 'before-round'])(
  'terminalizes %s control loss with receipts and no new decision',
  async (stage) => {
    const requests: AgentRequest[] = [];
    const finish = vi.fn(async () => {});
    const call = vi.fn(async (method: string) => {
      if (
        (method === 'fill' && ['after-fill', 'during-fill'].includes(stage)) ||
        (method === 'snapshot' && stage === 'snapshot')
      ) {
        executor.currentControl.mockReturnValue(null);
        executor.controlLossRevision.mockReturnValue(1);
        if (stage !== 'after-fill')
          throw Object.assign(new Error('PRIVATE_DETAIL'), {
            code: stage === 'snapshot' ? 'STOPPED' : 'OTHER',
          });
      }
      return { text: 'PRIVATE_PAGE', filled: true };
    });
    const loop = new BrowserLoop({
      send: (request) => {
        requests.push(request);
        return true;
      },
      input: () => true,
      execute: (actions, active, id, updates, expectedControl) =>
        runBrowserRound(actions, call, active, id, updates, expectedControl),
      finish,
      cancel: () => {},
    });
    const flush = async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    };
    loop.start(
      'task',
      { role: 'user', content: [{ type: 'text', text: 'PRIVATE_GOAL' }] },
      { type: 'current-page', status: 'unavailable' },
    );
    loop.accept(requests[0]!.id, {
      kind: 'actions',
      actions: [
        { method: 'read-page', params: { contextId: '11111111-1111-4111-8111-111111111111' } },
      ],
    });
    await flush();
    expect(requests).toHaveLength(2);
    if (stage === 'before-round') executor.currentControl.mockReturnValue(null);
    loop.accept(requests[1]!.id, {
      kind: 'actions',
      actions: [
        { method: 'fill', params: { ref: '@input', text: 'PRIVATE_INPUT' } },
        ...(stage === 'snapshot' ? [] : [{ method: 'click', params: { ref: '@submit' } }]),
      ],
    });
    await flush();
    expect(requests).toHaveLength(2);
    expect(loop.active).toBe(false);
    expect(finish).toHaveBeenCalledWith(
      expect.any(String),
      'interrupted',
      'task',
      { kind: 'interrupted' },
      {
        reason: 'CONTROL_LOST',
        observation: 'unavailable',
        resume: 'new-user-message-required',
        results: [
          {
            method: 'fill',
            outcome:
              stage === 'during-fill'
                ? 'uncertain'
                : stage === 'before-round'
                  ? 'not-executed'
                  : 'completed',
          },
          ...(stage === 'snapshot' ? [] : [{ method: 'click', outcome: 'not-executed' }]),
        ],
      },
    );
    expect(call.mock.calls.filter(([method]) => method === 'fill')).toHaveLength(
      stage === 'before-round' ? 0 : 1,
    );
    expect(
      call.mock.calls.some(
        ([method]) => method === 'click' || method === 'use-current-tab' || method === 'open',
      ),
    ).toBe(false);
    expect(JSON.stringify(finish.mock.calls)).not.toContain('PRIVATE');
    expect(() => loop.accept(requests[1]!.id + '-stale', { kind: 'done', text: 'late' })).toThrow();
  },
);

it('keeps an initial selection failure recoverable when no control was acquired', async () => {
  executor.currentControl.mockReturnValue(null);
  const call = vi.fn(async () => {
    throw Object.assign(new Error('selection denied'), { code: 'TAB_NOT_GRANTED' });
  });
  await expect(
    runBrowserRound([{ method: 'use-current-tab', params: {} }], call, () => {}, 'r'),
  ).resolves.toMatchObject({ mode: 'reading', failed: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('finishes an in-flight edit then skips the rest of the batch when input is updated', async () => {
  let updated = false;
  const call = vi.fn(async (method: string) => {
    if (method === 'fill') updated = true;
    return { text: 'fresh state' };
  });
  const result = await runBrowserRound(
    [
      { method: 'fill', params: { ref: '@input', value: 'old value' } },
      { method: 'click', params: { ref: '@submit' } },
    ],
    call,
    () => {},
    'r',
    () => updated,
  );
  expect(call.mock.calls.map(([m]) => m)).toEqual(['fill', 'snapshot', 'tabs']);
  expect(result.failed).toBe(false);
  expect(result.results).toMatchObject([
    { method: 'fill', status: 'success' },
    { status: 'skipped', count: 1 },
  ]);
});
it('preserves attachment metadata when page text exhausts the observation budget', async () => {
  const screenshot = {
    id: 'image-1',
    type: 'image',
    name: 'screenshot.png',
    mimeType: 'image/png',
    bytes: 3,
    data: 'AAAA',
  };
  const call = vi.fn(async (method: string) =>
    method === 'observe'
      ? {
          text: 'a'.repeat(15000),
          otherText: 'b'.repeat(15000),
          screenshot,
        }
      : [],
  );
  const result = await runBrowserRound([{ method: 'observe', params: {} }], call, () => {}, 'r');
  expect(result.observation).toHaveProperty('page.screenshot', screenshot);
  expect(JSON.stringify(result.observation).length).toBeLessThan(21000);
});
it('returns a DOM read directly without snapshot, settle, tabs or popup work', async () => {
  executor.currentControl.mockReturnValue(null);
  const call = vi.fn(async () => ({ text: 'article', nextOffset: null }));
  const result = await runBrowserRound(
    [{ method: 'read-page', params: { contextId: 'message' } }],
    call,
    () => {},
    'read',
  );
  expect(result).toMatchObject({
    mode: 'reading',
    failed: false,
    observation: { page: { text: 'article' } },
  });
  expect(call).toHaveBeenCalledTimes(1);
  expect(executor.flushTaskPopups).not.toHaveBeenCalled();
});
it('does not fall back to CDP after a denied read', async () => {
  executor.currentControl.mockReturnValue(null);
  const call = vi.fn(async () => {
    throw Object.assign(new Error('denied'), { code: 'READ_DENIED' });
  });
  const result = await runBrowserRound(
    [{ method: 'read-page', params: {} }],
    call,
    () => {},
    'read',
  );
  expect(result).toMatchObject({
    mode: 'reading',
    failed: true,
    observation: { error: { code: 'READ_DENIED' } },
  });
  expect(call).toHaveBeenCalledTimes(1);
});
it('executor revocation ends the round without asking for another browser decision', async () => {
  const call = vi.fn(async () => {
    throw Object.assign(new Error('owner revoked control'), { code: 'STOPPED' });
  });
  await expect(
    runBrowserRound([{ method: 'click', params: { ref: '@real' } }], call, () => {}, 'r'),
  ).rejects.toMatchObject({ code: 'STOPPED' });
  expect(call).toHaveBeenCalledTimes(1);
});
it('retries a changing read without replaying the successful input', async () => {
  let reads = 0;
  const call = vi.fn(async (method: string) => {
    if (method === 'snapshot' && reads++ === 0)
      throw Object.assign(new Error('changed'), { code: 'PAGE_CHANGED' });
    return { text: 'fresh state' };
  });
  const round = runBrowserRound(
    [{ method: 'click', params: { ref: '@real' } }],
    call,
    () => {},
    'r',
  );
  await vi.advanceTimersByTimeAsync(1200);
  const result = await round;
  expect(result.failed).toBe(false);
  expect(call.mock.calls.filter(([method]) => method === 'click')).toHaveLength(1);
  expect(call.mock.calls.filter(([method]) => method === 'snapshot')).toHaveLength(2);
});
it('navigation interrupts remaining form edits even when the URL did not change', async () => {
  const call = vi.fn(async (method: string) => {
    if (method === 'fill') executor.browserPageVersion.mockReturnValue('task:1:2');
    return { text: 'new page' };
  });
  const result = await runBrowserRound(
    [
      { method: 'fill', params: { ref: '@a', text: 'one' } },
      { method: 'fill', params: { ref: '@b', text: 'two' } },
    ],
    call,
    () => {},
    'r',
  );
  expect(call.mock.calls.filter(([method]) => method === 'fill')).toHaveLength(1);
  expect(result.results).toContainEqual(expect.objectContaining({ status: 'skipped', count: 1 }));
});
it('multiple actual child tabs are reported without silently choosing one', async () => {
  executor.taskPopupOpener.mockReturnValue(1);
  const call = vi.fn(async (method: string) => {
    if (method === 'click')
      executor.currentControl.mockReturnValue({ sessionId: 'task', tabId: 1, tabIds: [1, 2, 3] });
    return { text: 'fresh state' };
  });
  const result = await runBrowserRound(
    [{ method: 'click', params: { ref: '@real' } }],
    call,
    () => {},
    'r',
  );
  expect(call.mock.calls.some(([method]) => method === 'switch-tab')).toBe(false);
  expect(result.results).toContainEqual(expect.objectContaining({ status: 'multiple-new-tabs' }));
});
it('a failed mutation stops its batch, returns current evidence and never retries input', async () => {
  const call = vi.fn(async (method: string) => {
    if (method === 'fill') throw Object.assign(new Error('detached'), { code: 'STALE_ELEMENT' });
    return { text: 'new state' };
  });
  const result = await runBrowserRound(
    [
      { method: 'fill', params: { ref: '@old', text: 'a' } },
      { method: 'keypress', params: { key: 'Enter' } },
    ],
    call,
    () => {},
    'r',
  );
  expect(result.failed).toBe(true);
  expect(call.mock.calls.map(([method]) => method)).toEqual(['fill', 'snapshot', 'tabs']);
});
it('preserves targeted read refs and includes an image only once', async () => {
  const image = { text: 'page', screenshot: { data: 'encoded-image', mimeType: 'image/png' } };
  const call = vi.fn(async (method: string) => (method === 'observe' ? image : {}));
  const result = await runBrowserRound([{ method: 'observe', params: {} }], call, () => {}, 'r');
  expect(call.mock.calls.map(([method]) => method)).toEqual(['observe', 'tabs']);
  expect(JSON.stringify(result).match(/encoded-image/g)).toHaveLength(1);
});
it('stop during settling prevents observation and any continuation', async () => {
  let active = true;
  const call = vi.fn(async () => ({}));
  const round = runBrowserRound(
    [{ method: 'click', params: { ref: '@real' } }],
    call,
    () => {
      if (!active) throw Object.assign(new Error('Stopped'), { code: 'STOPPED' });
    },
    'r',
  );
  const rejected = expect(round).rejects.toMatchObject({ code: 'STOPPED' });
  await vi.advanceTimersByTimeAsync(100);
  active = false;
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(call).toHaveBeenCalledTimes(1);
});
