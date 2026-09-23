import { expect, test } from 'vitest';
import { visibleLayout, type LayoutDocument } from '../../utils/automation/viewport';

function document(): LayoutDocument {
  return {
    frameId: 0,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    nodes: { parentIndex: [-1, 0, 1, 1, 0, 4], backendNodeId: [10, 11, 12, 13, 14, 15] },
    layout: {
      nodeIndex: [0, 1, 2, 3, 4, 5],
      bounds: [
        [0, 0, 500, 3000],
        [0, 50, 500, 100],
        [0, 60, 100, 20],
        [0, 200, 100, 20],
        [0, 300, 500, 300],
        [0, 300, 100, 20],
      ],
      styles: [
        [0, 0, 1, 2],
        [0, 3, 1, 2],
        [0, 0, 1, 2],
        [0, 0, 1, 2],
        [0, 0, 1, 4],
        [0, 0, 1, 2],
      ],
      text: [5, 5, 5, 5, 5, 5],
    },
    textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
  };
}
const strings = ['visible', 'visible', '1', 'auto', '0', ''];
test('layout filters offscreen nodes, container overflow and transparent ancestors', () => {
  const doc = document();
  const viewport = { x: 0, y: 0, width: 500, height: 500 };
  expect([...visibleLayout(doc, strings, viewport).keys()]).toEqual([10, 11, 12]);
  doc.scrollOffsetY = 180;
  expect([...visibleLayout(doc, strings, viewport).keys()]).toEqual([10]);
  // Scrolling the inner container moves its children, not the outer viewport.
  doc.scrollOffsetY = 0;
  doc.layout.bounds[2]![1] = -90;
  doc.layout.bounds[3]![1] = 50;
  expect([...visibleLayout(doc, strings, viewport).keys()]).toEqual([10, 11, 13]);
});
test('long text uses visible line boxes instead of repeating its beginning', () => {
  const doc: LayoutDocument = {
    frameId: 0,
    scrollOffsetY: 100,
    nodes: { parentIndex: [-1, 0], backendNodeId: [1, 2] },
    layout: {
      nodeIndex: [0, 1],
      bounds: [
        [0, 0, 200, 400],
        [0, 0, 200, 300],
      ],
      styles: [[], []],
      text: [0, 1],
    },
    textBoxes: {
      layoutIndex: [1, 1, 1],
      bounds: [
        [0, 0, 100, 20],
        [0, 100, 100, 20],
        [0, 200, 100, 20],
      ],
      start: [0, 4, 8],
      length: [4, 4, 4],
    },
  };
  const visible = visibleLayout(doc, ['', 'AAAABBBBCCCC'], { x: 0, y: 0, width: 200, height: 100 });
  expect(visible.get(2)?.text).toBe('BBBB');
  doc.scrollOffsetY = 200;
  expect(
    visibleLayout(doc, ['', 'AAAABBBBCCCC'], { x: 0, y: 0, width: 200, height: 100 }).get(2)?.text,
  ).toBe('CCCC');
});
