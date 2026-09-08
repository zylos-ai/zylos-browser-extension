import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cursorExpression } from '../../utils/automation/cursor';

const owner = 'test-cursor';
const render = (update: Record<string, unknown>) =>
  (0, eval)(cursorExpression({ owner, ...update })) as Promise<{ arrived: boolean }> | undefined;
let animations: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[];
let animate: ReturnType<typeof vi.fn>;
let originalAnimate: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  animations = [];
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal(
    'CSSStyleSheet',
    class {
      replaceSync() {}
    },
  );
  animate = vi.fn(() => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const animation = { finished, finish, cancel: vi.fn() };
    animations.push(animation);
    return animation;
  });
  originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
});
afterEach(() => {
  render({ action: 'remove' });
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(Element.prototype, 'animate');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test('first appearance, same-position and reduced-motion previews never add a fixed delay', async () => {
  await expect(render({ action: 'move', x: 100, y: 100, waitForArrival: true })).resolves.toEqual({
    arrived: true,
  });
  await expect(render({ action: 'move', x: 100, y: 100, waitForArrival: true })).resolves.toEqual({
    arrived: true,
  });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  await expect(render({ action: 'move', x: 300, y: 150, waitForArrival: true })).resolves.toEqual({
    arrived: true,
  });
  expect(animate).not.toHaveBeenCalled();
});
test('native samples use exact event coordinates without an independent animation', async () => {
  await render({ action: 'move', x: 300, y: 300 });
  await expect(
    render({ action: 'move', x: 0, y: 1, nativePoint: true, waitForArrival: true }),
  ).resolves.toEqual({ arrived: true });
  const state = (
    globalThis as unknown as { __cocoVisualCursor: { position: { x: number; y: number } } }
  ).__cocoVisualCursor;
  expect(state.position).toEqual({ x: 0, y: 1 });
  expect(animate).not.toHaveBeenCalled();
});
test('movement resolves on arrival, and removal cancels pending movement', async () => {
  await render({ action: 'move', x: 100, y: 100 });
  const arrival = render({ action: 'move', x: 350, y: 150, waitForArrival: true });
  expect(document.querySelector<HTMLElement>('#coco-agent-cursor')?.dataset.movement).toBe(
    'moving',
  );
  animations[0]!.finish();
  await expect(arrival).resolves.toEqual({ arrived: true });
  const cancelled = render({ action: 'move', x: 150, y: 150, waitForArrival: true });
  render({ action: 'remove' });
  await expect(cancelled).resolves.toEqual({ arrived: false });
  expect(document.querySelector('#coco-agent-cursor')).toBeNull();
});
test('throttled animations are bounded and superseded moves cannot finish newer previews', async () => {
  await render({ action: 'move', x: 100, y: 100 });
  const old = render({ action: 'move', x: 350, y: 150, waitForArrival: true });
  const current = render({ action: 'move', x: 150, y: 250, waitForArrival: true });
  await expect(old).resolves.toEqual({ arrived: false });
  animations[0]!.finish();
  await Promise.resolve();
  expect(document.querySelector<HTMLElement>('#coco-agent-cursor')?.dataset.movement).toBe(
    'moving',
  );
  await vi.advanceTimersByTimeAsync(400);
  await expect(current).resolves.toEqual({ arrived: false });
});
test('MCP first appearance animates from a UI anchor and heartbeat never creates a cursor', async () => {
  render({ action: 'heartbeat' });
  expect(document.querySelector('#coco-agent-cursor')).toBeNull();
  const arrival = render({
    action: 'input',
    x: 100,
    y: 100,
    waitForArrival: true,
    animateFromAnchor: true,
  });
  expect(document.querySelector<HTMLElement>('#coco-agent-cursor')?.dataset.movement).toBe(
    'moving',
  );
  render({ action: 'heartbeat' });
  expect(document.querySelector<HTMLElement>('#coco-agent-cursor')?.dataset.movement).toBe(
    'moving',
  );
  animations[0]!.finish();
  await expect(arrival).resolves.toEqual({ arrived: true });
});
test('heartbeat retains a hidden cursor without revealing it; loss of heartbeat self-cleans', async () => {
  await render({ action: 'input', x: 100, y: 100 });
  render({ action: 'hide' });
  await vi.advanceTimersByTimeAsync(2000);
  render({ action: 'heartbeat' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(document.querySelector<HTMLElement>('#coco-agent-cursor')?.style.visibility).toBe(
    'hidden',
  );
  render({ action: 'restore' });
  expect(document.querySelector<HTMLElement>('#coco-agent-cursor')?.style.visibility).toBe(
    'visible',
  );
  await vi.advanceTimersByTimeAsync(1001);
  expect(document.querySelector('#coco-agent-cursor')).toBeNull();
  render({ action: 'heartbeat' });
  expect(document.querySelector('#coco-agent-cursor')).toBeNull();
});
