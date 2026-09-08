import type { Point } from './types';

type Params = Record<string, unknown>;
type Viewport = { width: number; height: number; reducedMotion?: boolean };
export type PointerIO = {
  check: () => void;
  send: (params: Params) => Promise<unknown>;
  show: (action: string, point: Point, moving?: boolean) => Promise<unknown>;
  viewport: () => Promise<Viewport>;
  hit: (point: Point) => Promise<{ backendNodeId: number; frameId: string }>;
};
const fail = (code: string) => {
  throw Object.assign(new Error(code), { code });
};

// Local pacing only: no cloud round trips, random jitter, overshoot or extra clicks.
export function pointerPath(from: Point, to: Point, reducedMotion = false) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = reducedMotion || distance < 2 ? 0 : Math.min(320, Math.max(100, distance * 0.4));
  const count = Math.max(1, Math.ceil(duration / 16));
  return Array.from({ length: count }, (_, i) => {
    const t = (i + 1) / count;
    const eased = t * t * (3 - 2 * t);
    return {
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      at: duration * t,
    };
  });
}

export class PointerMotion {
  private position: Point | null = null;
  private buttons = 0;
  private button = 'none';
  private queue: Promise<unknown> = Promise.resolve();

  reset() {
    this.position = null;
    this.buttons = 0;
    this.button = 'none';
  }

  dispatch(params: Params, io: PointerIO): Promise<unknown> {
    const next = this.queue.catch(() => {}).then(() => this.run(params, io));
    this.queue = next.catch(() => {});
    return next;
  }

  private async run(params: Params, io: PointerIO) {
    io.check();
    const { x, y, type } = params;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      fail('INVALID_MOUSE_POINT');
    const point = { x: x as number, y: y as number };
    if (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(String(type)))
      fail('INVALID_MOUSE_EVENT');

    // Never interpolate a release: doing so could turn a click into a drag.
    if (type !== 'mouseReleased') {
      const viewport = await io.viewport();
      io.check();
      if (!(viewport.width > 0 && viewport.height > 0)) fail('OBSERVATION_UNAVAILABLE');
      if (point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height)
        fail('MOUSE_OUTSIDE_VIEWPORT');
      const before = type === 'mousePressed' ? await io.hit(point) : null;
      io.check();
      if (before && !before.backendNodeId) fail('ELEMENT_UNAVAILABLE');
      const moveParams: Params =
        type === 'mouseMoved'
          ? { ...params }
          : {
              modifiers: params.modifiers,
              pointerType: params.pointerType,
              button: this.button,
              buttons: this.buttons,
            };
      // Let Chrome stamp each interpolated event with its actual dispatch time.
      delete moveParams.timestamp;
      const sendPoint = async (next: Point, moving = true) => {
        io.check();
        await io.send({ ...moveParams, type: 'mouseMoved', x: next.x, y: next.y });
        io.check();
        this.position = { x: next.x, y: next.y };
        await io.show('move', this.position, moving);
        io.check();
      };
      if (!this.position) {
        // This is the Agent's initial position, not an estimate of the user's cursor.
        await sendPoint({
          x: Math.max(0, viewport.width - 60),
          y: Math.max(0, viewport.height - 60),
        });
      }
      const from = this.position!;
      if (type === 'mouseMoved' || from.x !== point.x || from.y !== point.y) {
        const started = performance.now();
        const path = pointerPath(from, point, viewport.reducedMotion);
        for (const [index, step] of path.entries()) {
          io.check();
          const delay = step.at - (performance.now() - started);
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          await sendPoint(step, index < path.length - 1);
        }
      }
      if (before) {
        const after = await io.hit(point);
        io.check();
        if (before.backendNodeId !== after.backendNodeId || before.frameId !== after.frameId)
          fail('ELEMENT_CHANGED_DURING_MOVE');
      }
    }
    io.check();
    // The final mouseMoved was already delivered by the trajectory. Don't duplicate it.
    const result = type === 'mouseMoved' ? {} : await io.send(params);
    io.check();
    this.position = point;
    const masks: Record<string, number> = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
    const mask = masks[String(params.button)] || 0;
    if (type === 'mousePressed') this.buttons |= mask;
    if (type === 'mouseReleased') this.buttons &= ~mask;
    if (typeof params.buttons === 'number') this.buttons = params.buttons;
    this.button = this.buttons ? String(params.button || this.button) : 'none';
    if (type === 'mousePressed' || type === 'mouseWheel') {
      await io.show(type === 'mousePressed' ? 'click' : 'scroll', point);
      io.check();
    }
    return result;
  }
}
