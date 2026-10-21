import { afterEach, expect, test, vi } from 'vitest';
import { PageActions, type ElementRef } from '../../utils/automation/page-actions';
import {
  clearFrameSessions,
  collectFrames,
  frameSessions,
  type Frame,
} from '../../utils/automation/frames';

const root: Frame = { id: 'root', url: 'https://example.com' };
const child: Frame = {
  id: 'child',
  parentId: 'root',
  url: 'https://example.com/frame',
  sessionId: 'session',
};
const coded = (code: string) => Object.assign(new Error(code), { code });
afterEach(() => {
  clearFrameSessions();
  vi.restoreAllMocks();
});

function setup(error?: Error, check = vi.fn()) {
  const refs = new Map<string, ElementRef>();
  const send = vi.fn(
    async (method: string, _params?: Record<string, unknown>, sessionId?: string): Promise<any> => {
      if (method === 'Accessibility.getFullAXTree') {
        if (sessionId && error) throw error;
        return {
          nodes: [
            {
              nodeId: sessionId || 'root',
              backendDOMNodeId: sessionId ? 2 : 1,
              role: { value: 'button' },
              name: { value: sessionId ? 'Child' : 'Root' },
            },
          ],
        };
      }
      return {};
    },
  );
  const actions = new PageActions({
    send,
    refs,
    generation: 1,
    check,
    mouse: vi.fn(),
    preview: vi.fn(),
    dragData: vi.fn(),
  });
  vi.spyOn(actions, 'safeFrames').mockResolvedValue([root, child]);
  return { actions, refs, send, check };
}

test('a missing child preserves root evidence with explicit partial status and no child refs', async () => {
  const { actions, refs } = setup(coded('FRAME_UNAVAILABLE'));
  const result = await actions.snapshot(false, []);
  expect(result).toMatchObject({ partial: true, nodeCount: 1, truncated: false });
  expect(result.warnings).toEqual(['A child frame became unavailable; snapshot is partial.']);
  expect(result.text).toContain('Root');
  expect(result.text).not.toContain('Child');
  expect([...refs.values()].map((ref) => ref.frame.id)).toEqual(['root']);
});

test.each([
  'STOPPED',
  'PAGE_CHANGED',
  'COMMAND_EXPIRED',
  'BLOCKED_URL',
  'SENSITIVE_INPUT',
  'OBSERVATION_UNAVAILABLE',
])('%s from a child remains fatal', async (code) => {
  const { actions } = setup(coded(code));
  await expect(actions.snapshot(false, [])).rejects.toMatchObject({ code });
});

test('raw detached errors and root frame loss remain fatal', async () => {
  const { actions, send } = setup(new Error('Detached while handling command'));
  await expect(actions.snapshot(false, [])).rejects.toThrow('Detached while handling command');
  send.mockRejectedValue(coded('FRAME_UNAVAILABLE'));
  await expect(actions.snapshot(false, [])).rejects.toMatchObject({ code: 'FRAME_UNAVAILABLE' });
});

test('a concurrent stop overrides child unavailability', async () => {
  const { actions } = setup(
    coded('FRAME_UNAVAILABLE'),
    vi.fn(() => {
      throw coded('STOPPED');
    }),
  );
  await expect(actions.snapshot(false, [])).rejects.toMatchObject({ code: 'STOPPED' });
});

test('failed child sensitive prepass does not expose values or descendants', async () => {
  const { actions, send, refs } = setup();
  send.mockImplementation(async (method, _params, session) => {
    if (method === 'Accessibility.getFullAXTree')
      return {
        nodes: session
          ? [
              {
                nodeId: 'input',
                backendDOMNodeId: 2,
                value: { value: 'PRIVATE' },
                role: { value: 'textbox' },
                name: { value: 'OTP' },
                childIds: ['text'],
              },
              { nodeId: 'text', role: { value: 'StaticText' }, name: { value: 'PRIVATE' } },
            ]
          : [
              {
                nodeId: 'root',
                backendDOMNodeId: 1,
                role: { value: 'button' },
                name: { value: 'Root' },
              },
            ],
      };
    if (method === 'DOM.resolveNode') throw coded('FRAME_UNAVAILABLE');
    return {};
  });
  const result = await actions.snapshot(false, []);
  expect(result.partial).toBe(true);
  expect(result.text).not.toMatch(/PRIVATE|OTP/);
  expect([...refs.values()].map((ref) => ref.frame.id)).toEqual(['root']);
});

test('only a child missing from captured layout may degrade', async () => {
  const { actions, send, refs } = setup();
  const original = send.getMockImplementation()!;
  vi.spyOn(actions as any, 'frameViewport').mockResolvedValue({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  send.mockImplementation(async (method, params, session) => {
    if (method === 'DOMSnapshot.captureSnapshot')
      return {
        strings: ['root'],
        documents: session
          ? []
          : [
              {
                frameId: 0,
                nodes: { parentIndex: [-1], backendNodeId: [1] },
                layout: { nodeIndex: [0], bounds: [[0, 0, 20, 20]], styles: [[]], text: [] },
                textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
              },
            ],
      };
    return original(method, params, session);
  });
  const result = await actions.snapshot(false, [], true);
  expect(result).toMatchObject({ partial: true, nodeCount: 1 });
  expect([...refs.values()].map((ref) => ref.frame.id)).toEqual(['root']);
  send.mockResolvedValue({ strings: [], documents: [] } as any);
  await expect(actions.snapshot(false, [], true)).rejects.toMatchObject({
    code: 'OBSERVATION_UNAVAILABLE',
  });
});

test('collection reports an advertised child disappearing and removes its subtree', async () => {
  frameSessions().set('session', { tabId: 1, frameId: 'child' });
  frameSessions().set('grand-session', { tabId: 1, frameId: 'grandchild', parent: 'session' });
  const send = vi.fn(
    async (_method: string, _params?: Record<string, unknown>, session?: string) => {
      if (session) {
        frameSessions().delete(session);
        throw coded('FRAME_UNAVAILABLE');
      }
      return {
        frameTree: {
          frame: root,
          childFrames: [
            { frame: child, childFrames: [{ frame: { id: 'grandchild', parentId: 'child' } }] },
          ],
        },
      };
    },
  );
  const missing = vi.fn();
  expect(await collectFrames(send, missing)).toEqual([root]);
  expect(missing).toHaveBeenCalledWith(expect.objectContaining({ id: 'child' }));
  expect(send).toHaveBeenCalledTimes(2);
});

test.each(['STOPPED', 'PAGE_CHANGED', 'Detached while handling command'])(
  'collection preserves child %s failure',
  async (message) => {
    frameSessions().set('session', { tabId: 1, frameId: 'child' });
    const error = message.startsWith('Detached') ? new Error(message) : coded(message);
    await expect(
      collectFrames(async (_method, _params, session) => {
        if (session) throw error;
        return { frameTree: { frame: root, childFrames: [{ frame: child }] } };
      }, vi.fn()),
    ).rejects.toBe(error);
  },
);
