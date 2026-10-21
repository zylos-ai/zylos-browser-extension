import { isBlockedUrl } from '../guard';
import { diagnosticSend, recordDebuggerEvent } from './cdp-diagnostics';

export type Frame = { id: string; parentId?: string; url?: string; sessionId?: string };
export type FrameTree = { frame: Frame; childFrames?: FrameTree[] };
export type Send = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<any>;
const autoAttach = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
};
const children = new Map<string, { tabId: number; parent?: string; frameId: string }>();
const pending = new Set<Promise<unknown>>();
let revision = 0;
export const frameSessions = () => children;
export function clearFrameSessions() {
  revision++;
  children.clear();
  pending.clear();
}
export async function enableFrames(
  target: { tabId: number; sessionId?: string },
  valid: () => boolean = () => true,
) {
  const started = revision;
  if (!valid()) return;
  await diagnosticSend(target, 'Network.enable', {
    maxTotalBufferSize: 0,
    maxResourceBufferSize: 0,
  });
  if (started !== revision || !valid()) return;
  await diagnosticSend(target, 'Target.setAutoAttach', autoAttach);
}
export function frameEvent(
  source: { tabId?: number; sessionId?: string },
  method: string,
  params: any,
  valid: () => boolean = () => true,
) {
  if (!source.tabId || !valid()) return;
  if (source.sessionId && children.get(source.sessionId)?.tabId !== source.tabId) return;
  if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
    recordDebuggerEvent('frame-attach', { tabId: source.tabId, sessionId: params.sessionId });
    const record = {
      tabId: source.tabId,
      parent: source.sessionId,
      frameId: params.targetInfo.targetId,
    };
    children.set(params.sessionId, record);
    const target = { tabId: source.tabId, sessionId: params.sessionId };
    const work = (async () => {
      await diagnosticSend(target, 'Page.enable');
      const current = () => valid() && children.get(params.sessionId) === record;
      if (!current()) return;
      await enableFrames(target, current);
    })()
      .catch(() => {})
      .finally(() => pending.delete(work));
    pending.add(work);
  }
  if (method === 'Target.detachedFromTarget') {
    recordDebuggerEvent('frame-detach', { tabId: source.tabId, sessionId: params.sessionId });
    const remove = (id: string) => {
      children.delete(id);
      for (const [child, value] of children) if (value.parent === id) remove(child);
    };
    remove(params.sessionId);
  }
}
export function frameAllowed(frame: Frame) {
  return (
    (!frame.url || /^https?:|^about:(blank|srcdoc)$/.test(frame.url)) && !isBlockedUrl(frame.url)
  );
}
export async function collectFrames(
  send: Send,
  onUnavailable?: (frame: Frame) => void,
): Promise<Frame[]> {
  // Auto-attach is recursive. Wait for already delivered attachment callbacks.
  for (let pass = 0; pending.size && pass < 8; pass++) await Promise.all([...pending]);
  const frames = new Map<string, Frame>();
  const walk = (tree: FrameTree, sessionId?: string, parentId?: string) => {
    const old = frames.get(tree.frame.id);
    frames.set(tree.frame.id, {
      ...old,
      ...tree.frame,
      parentId: tree.frame.parentId || parentId || old?.parentId,
      sessionId,
    });
    for (const child of tree.childFrames || []) walk(child, sessionId, tree.frame.id);
  };
  const root = await send('Page.getFrameTree');
  if (!root.frameTree)
    throw Object.assign(new Error('Frame tree unavailable'), { code: 'FRAME_UNAVAILABLE' });
  walk(root.frameTree);
  const unavailableFrames = new Set<string>();
  for (const [sessionId, child] of children) {
    if (unavailableFrames.has(child.frameId)) continue;
    try {
      const result = await send('Page.getFrameTree', {}, sessionId);
      if (result.frameTree) walk(result.frameTree, sessionId);
      else if (onUnavailable)
        throw Object.assign(new Error('Frame tree unavailable'), { code: 'FRAME_UNAVAILABLE' });
    } catch (error) {
      if (onUnavailable) {
        const frame = frames.get(child.frameId);
        if (!frame?.parentId || (error as { code?: string })?.code !== 'FRAME_UNAVAILABLE')
          throw error;
        onUnavailable(frame);
        const remove = (id: string) => {
          unavailableFrames.add(id);
          frames.delete(id);
          for (const child of [...frames.values()]) if (child.parentId === id) remove(child.id);
        };
        remove(frame.id);
        continue;
      }
      if (error && typeof error === 'object' && 'code' in error) throw error;
      // A frame may disappear while a snapshot is being gathered.
    }
  }
  return [...frames.values()];
}
