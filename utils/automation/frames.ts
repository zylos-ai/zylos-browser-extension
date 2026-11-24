import { isSiteUrlBlocked } from '../site-access';
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
    (!frame.url || /^https?:|^about:(blank|srcdoc)$/.test(frame.url)) &&
    !isSiteUrlBlocked(frame.url)
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

/** Deepest focused element, through open shadow roots. Serialized for CDP. */
export const FOCUSED_ELEMENT = `(() => {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement)
    active = active.shadowRoot.activeElement;
  return active;
})()`;

function frameUnavailable(): never {
  throw Object.assign(new Error('Focused frame unavailable'), { code: 'FRAME_UNAVAILABLE' });
}

/**
 * Native text input (Input.insertText) and keys are delivered to the focused
 * document, not to every frame in the page. Check the top frame and the focus
 * chain down to the frame that will receive the input, so an unrelated hidden
 * third-party iframe (for example a Stripe telemetry frame) does not block
 * typing into the top document, while typing into a restricted frame is still
 * blocked. Any focused frame owner is followed (iframe, frame, object, embed).
 * The chain is discovered only through frames that already passed assertFrame.
 * If the focused element cannot be inspected, every collected frame is
 * checked; a focused child frame missing from the collected list fails with
 * FRAME_UNAVAILABLE.
 */
export async function assertInputFrames(
  send: Send,
  assertFrame: (frame: Frame) => void,
  collected?: Frame[],
) {
  const frames = collected ?? (await collectFrames(send));
  const all = () => {
    for (const frame of frames) assertFrame(frame);
  };
  const top = frames.find((frame) => !frame.parentId);
  if (!top) return all();
  assertFrame(top);
  const seen = new Set<string>([top.id]);
  let current = top;
  for (let depth = 0; depth < 16; depth++) {
    let childId: string | undefined;
    try {
      const world = await send(
        'Page.createIsolatedWorld',
        { frameId: current.id, worldName: 'coco-focus' },
        current.sessionId,
      );
      if (!world?.executionContextId) return all();
      const result = await send(
        'Runtime.evaluate',
        {
          expression: FOCUSED_ELEMENT,
          contextId: world.executionContextId,
          returnByValue: false,
          objectGroup: 'coco-browser',
        },
        current.sessionId,
      );
      if (result?.exceptionDetails) return all();
      const objectId = result?.result?.objectId;
      if (!objectId) return; // Nothing focused: input stays in this checked frame.
      const { node } = await send('DOM.describeNode', { objectId, depth: 0 }, current.sessionId);
      if (!node) return all();
      childId = node.frameId || node.contentDocument?.frameId;
    } catch {
      return all();
    }
    if (!childId) return; // Focus ends on an element of this already checked frame.
    const parentId = current.id;
    const child = frames.find((frame) => frame.id === childId && frame.parentId === parentId);
    if (!child || seen.has(child.id)) frameUnavailable();
    seen.add(child.id);
    assertFrame(child);
    current = child;
  }
  all();
}
