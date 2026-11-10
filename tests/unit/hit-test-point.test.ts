// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { hitTestPoint } from '../../utils/automation/point-permissions';

const hit = { backendNodeId: 42, frameId: 'main' };
const options = { includeUserAgentShadowDOM: false, ignorePointerEventsNone: false };

test.each([
  [{ cssLayoutViewport: { pageX: 120, pageY: 1068 } }, { x: 632, y: 628 }, { x: 752, y: 1696 }],
  [{ cssLayoutViewport: { pageX: -100, pageY: 200 } }, { x: 120, y: 30 }, { x: 20, y: 230 }],
  [{ cssLayoutViewport: { pageX: 0, pageY: 0 } }, { x: 10.9, y: 20.8 }, { x: 10, y: 20 }],
  [
    {
      cssLayoutViewport: { pageX: 10, pageY: 2000 },
      cssVisualViewport: { pageX: 25.25, pageY: 2034.75, scale: 2 },
    },
    { x: 10.8, y: 20.5 },
    { x: 36, y: 2055 },
  ],
])(
  'converts viewport coordinates with CSS document offsets %#',
  async (metrics, point, expected) => {
    const send = vi.fn(async (method: string) =>
      method === 'Page.getLayoutMetrics' ? metrics : hit,
    );
    const original = { ...point };
    await expect(hitTestPoint(send, point, options)).resolves.toEqual(hit);
    expect(send).toHaveBeenLastCalledWith('DOM.getNodeForLocation', { ...options, ...expected });
    expect(point).toEqual(original);
  },
);

test.each([
  undefined,
  null,
  {},
  { cssLayoutViewport: { pageX: 0 } },
  { cssLayoutViewport: { pageX: NaN, pageY: 0 } },
  { cssLayoutViewport: { pageX: 0, pageY: Infinity } },
  { cssLayoutViewport: { pageX: 0, pageY: 0 }, cssVisualViewport: { pageX: 0 } },
])('fails closed for missing or invalid CSS viewport metrics %#', async (metrics) => {
  const send = vi.fn(async () => metrics);
  await expect(hitTestPoint(send, { x: 10, y: 20 }, options)).rejects.toMatchObject({
    code: 'FRAME_UNAVAILABLE',
  });
  expect(send).toHaveBeenCalledExactlyOnceWith('Page.getLayoutMetrics', {});
});

test('rejects nonfinite input and overflowing document coordinates before hit testing', async () => {
  const send = vi.fn(async () => ({ cssLayoutViewport: { pageX: Number.MAX_VALUE, pageY: 0 } }));
  await expect(hitTestPoint(send, { x: Infinity, y: 0 }, options)).rejects.toMatchObject({
    code: 'FRAME_UNAVAILABLE',
  });
  expect(send).not.toHaveBeenCalled();
  await expect(hitTestPoint(send, { x: Number.MAX_VALUE, y: 0 }, options)).rejects.toMatchObject({
    code: 'FRAME_UNAVAILABLE',
  });
  expect(send).toHaveBeenCalledExactlyOnceWith('Page.getLayoutMetrics', {});
});
