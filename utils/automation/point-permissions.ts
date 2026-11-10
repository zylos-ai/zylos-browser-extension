import type { Frame, Send } from './frames';
import { collectFrames } from './frames';
import type { CdpResults, Point } from './types';

function unavailable(): never {
  throw Object.assign(new Error('Frame target unavailable'), { code: 'FRAME_UNAVAILABLE' });
}

export async function hitTestPoint(
  send: (
    method: 'Page.getLayoutMetrics' | 'DOM.getNodeForLocation',
    params: Record<string, unknown>,
  ) => Promise<unknown>,
  point: Point,
  options: { includeUserAgentShadowDOM: boolean; ignorePointerEventsNone?: boolean },
): Promise<CdpResults['DOM.getNodeForLocation']> {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) unavailable();
  const metrics = (await send('Page.getLayoutMetrics', {})) as CdpResults['Page.getLayoutMetrics'];
  const viewport = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
  if (!Number.isFinite(viewport?.pageX) || !Number.isFinite(viewport?.pageY)) unavailable();
  // Input uses viewport CSS coordinates; DOM hit testing uses document CSS coordinates.
  const x = Math.floor(point.x + viewport.pageX);
  const y = Math.floor(point.y + viewport.pageY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) unavailable();
  return (await send('DOM.getNodeForLocation', {
    ...options,
    x,
    y,
  })) as CdpResults['DOM.getNodeForLocation'];
}

// OOPIF hit tests return the embedding element and its parent's frameId. Check
// the whole embedded subtree without translating points into child-local coordinates.
export async function assertPointPermissions(
  send: Send,
  point: { x: number; y: number },
  assertFrame: (frame: Frame) => void,
) {
  const hit = await hitTestPoint(send, point, {
    includeUserAgentShadowDOM: true,
  });
  if (!hit.backendNodeId || !hit.frameId) unavailable();
  const frames = await collectFrames(send);
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const frame = byId.get(hit.frameId);
  if (!frame) unavailable();
  const checked = new Set<string>();
  const checkChain = (start: Frame) => {
    let current: Frame | undefined = start;
    const chain = new Set<string>();
    while (current) {
      if (chain.has(current.id)) unavailable();
      chain.add(current.id);
      assertFrame(current);
      checked.add(current.id);
      if (!current.parentId) break;
      current = byId.get(current.parentId);
      if (!current) unavailable();
    }
  };
  checkChain(frame);
  const { node } = await send(
    'DOM.describeNode',
    { backendNodeId: hit.backendNodeId, depth: 0 },
    frame.sessionId,
  );
  if (!node || typeof node.nodeName !== 'string') unavailable();
  if (!['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(node.nodeName.toUpperCase())) return;
  const childId = node.frameId || node.contentDocument?.frameId;
  const child = byId.get(childId);
  if (!child || child.parentId !== frame.id) unavailable();
  checkChain(child);
  const pending = [child.id];
  while (pending.length) {
    const parentId = pending.pop()!;
    for (const descendant of frames) {
      if (descendant.parentId !== parentId) continue;
      if (checked.has(descendant.id)) unavailable();
      checkChain(descendant);
      pending.push(descendant.id);
    }
  }
}
