// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { PointerMotion, pointerPath, type PointerIO } from '../../utils/automation/pointer-motion';

afterEach(() => vi.useRealTimers());
function setup() {
  const events: Record<string, unknown>[] = [];
  const displays: { action: string; x: number; y: number }[] = [];
  const io: PointerIO = {
    check: vi.fn(),
    viewport: async () => ({ width: 800, height: 600 }),
    hit: vi.fn(async () => ({ backendNodeId: 1, frameId: 'main' })),
    send: vi.fn(async (p) => {
      events.push(p);
      return {};
    }),
    show: vi.fn(async (action, p) => {
      displays.push({ action, x: p.x, y: p.y });
    }),
  };
  return { motion: new PointerMotion(), io, events, displays };
}
async function finish<T>(promise: Promise<T>) {
  await vi.runAllTimersAsync();
  return promise;
}
test('bounded eased trajectory lands exactly, with no overshoot; reduced motion is immediate', () => {
  const from = { x: 740, y: 540 },
    to = { x: 100, y: 80 };
  const path = pointerPath(from, to);
  expect(path.length).toBeLessThanOrEqual(20);
  expect(path.at(-1)).toMatchObject(to);
  expect(path.at(-1)!.at).toBeLessThanOrEqual(320);
  expect(path.every((p) => p.x >= 100 && p.x <= 740 && p.y >= 80 && p.y <= 540)).toBe(true);
  expect(pointerPath(from, to, true)).toEqual([{ ...to, at: 0 }]);
});
test('native movement precedes one press/release; each displayed position follows a dispatched sample', async () => {
  vi.useFakeTimers();
  const s = setup();
  const press = {
    type: 'mousePressed',
    x: 100,
    y: 80,
    button: 'left',
    clickCount: 1,
    modifiers: 2,
  };
  await finish(s.motion.dispatch(press, s.io));
  const count = s.events.length;
  await finish(s.motion.dispatch({ ...press, type: 'mouseReleased' }, s.io));
  expect(count).toBeGreaterThan(3);
  expect(s.events.slice(0, -2).every((p) => p.type === 'mouseMoved')).toBe(true);
  expect(s.events.at(-2)).toEqual(press);
  expect(s.events.at(-1)?.type).toBe('mouseReleased');
  expect(s.events.length).toBe(count + 1);
  expect(s.displays.map(({ x, y }) => ({ x, y }))).toEqual(
    s.events.slice(0, -1).map(({ x, y }) => ({ x, y })),
  );
  expect(s.events[0]).toMatchObject({ x: 740, y: 540, buttons: 0, modifiers: 2 });
  expect(s.io.hit).toHaveBeenCalledTimes(2);
});
test('explicit moves preserve drag/modifier fields and never duplicate the endpoint', async () => {
  vi.useFakeTimers();
  const s = setup();
  await finish(
    s.motion.dispatch(
      { type: 'mouseMoved', x: 10, y: 20, buttons: 1, button: 'left', modifiers: 4, timestamp: 1 },
      s.io,
    ),
  );
  expect(
    s.events.every((p) => p.buttons === 1 && p.modifiers === 4 && p.timestamp === undefined),
  ).toBe(true);
  expect(s.events.filter((p) => p.x === 10 && p.y === 20)).toHaveLength(1);
  expect(s.io.hit).not.toHaveBeenCalled();
});
test('hover changing the hit target aborts before pressing', async () => {
  vi.useFakeTimers();
  const s = setup();
  s.io.hit = vi
    .fn()
    .mockResolvedValueOnce({ backendNodeId: 1, frameId: 'main' })
    .mockResolvedValueOnce({ backendNodeId: 2, frameId: 'main' });
  const rejected = expect(
    s.motion.dispatch({ type: 'mousePressed', x: 100, y: 80 }, s.io),
  ).rejects.toMatchObject({ code: 'ELEMENT_CHANGED_DURING_MOVE' });
  await finish(rejected);
  expect(s.events.every((p) => p.type === 'mouseMoved')).toBe(true);
});
test.each(['STOPPED', 'PAGE_CHANGED', 'COMMAND_EXPIRED'])(
  '%s cancels remaining samples and pending press',
  async (code) => {
    vi.useFakeTimers();
    const s = setup();
    s.io.check = () => {
      if (s.events.length >= 3) throw Object.assign(new Error(code), { code });
    };
    const rejected = expect(
      s.motion.dispatch({ type: 'mousePressed', x: 100, y: 80 }, s.io),
    ).rejects.toMatchObject({ code });
    await finish(rejected);
    expect(s.events).toHaveLength(3);
    expect(s.events.every((p) => p.type === 'mouseMoved')).toBe(true);
  },
);
test('queued movement cannot interleave; a failed operation does not poison the queue', async () => {
  vi.useFakeTimers();
  const s = setup();
  const rejected = expect(
    s.motion.dispatch({ type: 'mouseMoved', x: NaN, y: 0 }, s.io),
  ).rejects.toMatchObject({ code: 'INVALID_MOUSE_POINT' });
  const a = s.motion.dispatch({ type: 'mouseMoved', x: 100, y: 80 }, s.io);
  const b = s.motion.dispatch({ type: 'mouseMoved', x: 200, y: 160 }, s.io);
  await finish(Promise.all([rejected, a, b]));
  const endA = s.events.findIndex((p) => p.x === 100 && p.y === 80);
  expect(endA).toBeGreaterThan(0);
  expect(s.events.slice(endA + 1).every((p) => Number(p.x) > 100 && Number(p.x) <= 200)).toBe(true);
  expect(s.events.at(-1)).toMatchObject({ x: 200, y: 160 });
});
test('new task resets the Agent position; out-of-viewport points do not emit input', async () => {
  vi.useFakeTimers();
  const s = setup();
  await finish(s.motion.dispatch({ type: 'mouseMoved', x: 100, y: 80 }, s.io));
  s.motion.reset();
  s.events.length = 0;
  await finish(s.motion.dispatch({ type: 'mouseMoved', x: 120, y: 80 }, s.io));
  expect(s.events[0]).toMatchObject({ x: 740, y: 540 });
  s.events.length = 0;
  await expect(s.motion.dispatch({ type: 'mouseMoved', x: -1, y: 80 }, s.io)).rejects.toMatchObject(
    { code: 'MOUSE_OUTSIDE_VIEWPORT' },
  );
  expect(s.events).toHaveLength(0);
});
