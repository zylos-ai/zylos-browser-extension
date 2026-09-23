// Shared layout for lifecycle tests. Geometry correctness is exercised against
// actual Chrome and separately in viewport.test.ts.
export function observationCdp(method, params) {
  if (method === 'Runtime.callFunctionOn' && params?.arguments?.[0]?.value === 'viewport')
    return { result: { value: { x: 0, y: 0, width: 800, height: 600 } } };
  if (method === 'Page.getLayoutMetrics')
    return {
      cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 },
      cssContentSize: { width: 800, height: 600 },
    };
  if (method === 'DOMSnapshot.captureSnapshot')
    return {
      strings: ['main', 'visible', '1'],
      documents: [
        {
          frameId: 0,
          nodes: { parentIndex: [-1], backendNodeId: [1] },
          layout: {
            nodeIndex: [0],
            bounds: [[10, 10, 100, 30]],
            styles: [[1, 1, 1, 2]],
            text: [-1],
          },
          textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
        },
      ],
    };
}
