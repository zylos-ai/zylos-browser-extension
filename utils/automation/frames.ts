import { isBlockedUrl } from '../guard';

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
export const frameSessions = () => children;
export function clearFrameSessions() {
  children.clear();
}
export async function enableFrames(target: { tabId: number; sessionId?: string }) {
  await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', autoAttach);
}
export function frameEvent(
  source: { tabId?: number; sessionId?: string },
  method: string,
  params: any,
) {
  if (!source.tabId) return;
  if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
    const record = {
      tabId: source.tabId,
      parent: source.sessionId,
      frameId: params.targetInfo.targetId,
    };
    children.set(params.sessionId, record);
    const target = { tabId: source.tabId, sessionId: params.sessionId };
    const work = (async () => {
      await chrome.debugger.sendCommand(target, 'Page.enable');
      if (children.get(params.sessionId) !== record) return;
      await enableFrames(target);
    })()
      .catch(() => {})
      .finally(() => pending.delete(work));
    pending.add(work);
  }
  if (method === 'Target.detachedFromTarget') {
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
export async function collectFrames(send: Send): Promise<Frame[]> {
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
  for (const [sessionId] of children) {
    try {
      const result = await send('Page.getFrameTree', {}, sessionId);
      if (result.frameTree) walk(result.frameTree, sessionId);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) throw error;
      // A frame may disappear while a snapshot is being gathered.
    }
  }
  return [...frames.values()];
}
