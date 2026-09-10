import { cursorExpression } from './cursor';
import { cleanupTask, recordTask } from './task-lifecycle';
import { PointerMotion } from './pointer-motion';
import domActionSource from './injected/dom-action.js?raw';
import type { Command } from '../commands';
import type { CdpResults, Cursor, DomResults, GrantedTab, Point, Scope } from './types';
import { CDP_METHODS, type CdpBind, type CdpBinding, type CdpRequest } from '../cdp-protocol';

let grant: GrantedTab | null = null;
const pointerMotion = new PointerMotion();
let cursor: Cursor | null = null;
let control: Scope | null = null;
let parked = false;
let pauseTimer: ReturnType<typeof setTimeout> | undefined;
let cdpBinding: CdpBinding | null = null;
let cursorHeartbeat: ReturnType<typeof setTimeout> | undefined;
function stopCursorHeartbeat() {
  clearTimeout(cursorHeartbeat);
  cursorHeartbeat = undefined;
}
function keepEngineCursor(visual: Cursor, binding: CdpBinding) {
  stopCursorHeartbeat();
  const alive = () =>
    cursor === visual && cdpBinding === binding && !!control && !parked && grant === visual.lease;
  if (!alive()) return;
  cursorHeartbeat = setTimeout(async () => {
    if (!alive()) return;
    try {
      await chrome.debugger.sendCommand({ tabId: visual.tabId }, 'Runtime.evaluate', {
        contextId: visual.contextId,
        expression: cursorExpression({ action: 'heartbeat', owner: visual.owner }),
        returnByValue: true,
        timeout: 500,
      });
      if (alive()) keepEngineCursor(visual, binding);
    } catch {
      /* The page visual expires by itself if the connection is lost. */
    }
  }, 1000);
}
let cdpEvent: (event: unknown) => void = () => {};
export const onCdpEvent = (fn: typeof cdpEvent) => {
  cdpEvent = fn;
};
let attachmentQueue: Promise<unknown> = Promise.resolve();
let consentRevision = 0;
let refs = new Map<string, { backendNodeId: number; generation: number }>();
let generation = 0;
let changed: (tab: GrantedTab | null) => void = () => {};
function fail(code: string, message = code): never {
  throw Object.assign(new Error(message), { code });
}
export const currentGrant = () => (control && grant ? { ...grant } : null);
export const currentControl = () => (control ? { ...control, tabIds: [...control.tabIds] } : null);
export const onState = (fn: typeof changed) => {
  changed = fn;
};
function invalidate() {
  generation++;
  refs.clear();
  pointerMotion.reset();
}
function allowed(url?: string) {
  try {
    const u = new URL(url || '');
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !['chromewebstore.google.com', 'chrome.google.com'].includes(u.hostname)
    );
  } catch {
    return false;
  }
}
const publish = () => changed(currentGrant());
const inScope = (tab: chrome.tabs.Tab, session: Scope | null) =>
  !!session &&
  tab.windowId === session.windowId &&
  !tab.incognito &&
  tab.id !== undefined &&
  session.tabIds.includes(tab.id) &&
  tab.groupId === session.groupId;
let groupUpdates: Promise<unknown> = Promise.resolve();
function markTask(session: Scope, phase: 'working' | 'paused') {
  const next = groupUpdates
    .catch(() => {})
    .then(async () => {
      if (control !== session) return;
      await chrome.tabGroups.update(session.groupId, {
        color: phase === 'working' ? 'green' : 'grey',
        title: `Coco Agent · ${phase === 'working' ? '工作中' : '等待继续'}`,
      });
    });
  groupUpdates = next.catch(() => {});
  return next;
}
const inspectable = (tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number; url: string } =>
  typeof tab.id === 'number' && allowed(tab.url) && (!tab.pendingUrl || allowed(tab.pendingUrl));
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = attachmentQueue.catch(() => {}).then(fn);
  attachmentQueue = next.catch(() => {});
  return next;
}
async function detachCurrent(strict = false) {
  cdpBinding = null;
  const old = grant;
  grant = null;
  invalidate();
  publish();
  await clearCursor();
  if (old) {
    try {
      await chrome.debugger.detach({ tabId: old.id });
    } catch {
      if (strict) {
        const targets = await chrome.debugger.getTargets().catch(() => null);
        if (targets && !targets.some((target) => target.tabId === old.id && target.attached))
          return;
        // Keep the target for an explicit cleanup retry; do not claim detach succeeded.
        grant = old;
        publish();
        fail('DEBUGGER_DETACH_FAILED', '未能释放浏览器调试连接，请停止控制后重试回复');
      }
    }
  }
}
async function clearCursor() {
  stopCursorHeartbeat();
  const previous = cursor;
  cursor = null;
  if (!previous) return;
  await chrome.debugger
    .sendCommand({ tabId: previous.tabId }, 'Runtime.evaluate', {
      contextId: previous.contextId,
      expression: cursorExpression({ action: 'remove', owner: previous.owner }),
      returnByValue: true,
      timeout: 500,
    })
    .catch(() => {});
}
export async function release(cleanup = true, strict = false) {
  clearTimeout(pauseTimer);
  cdpBinding = null;
  const previous = control;
  // Revoke synchronously: queued or in-flight attachments cannot revive consent.
  control = null;
  parked = true;
  consentRevision++;
  invalidate();
  publish();
  await serial(() => detachCurrent(strict));
  // Closing temporary tabs / ungrouping retained pages removes an empty group.
  // Do not create a terminal-status group or rename user-owned remaining tabs.
  if (previous && cleanup) await cleanupTask(previous.sessionId).catch(() => {});
  await chrome.action.setBadgeText({ text: '' });
  publish();
}
// tabId comes from explicit panel consent or a verified chat handoff, never a model.
export async function attach(
  tabId: number,
  mode: 'current' | 'new' = 'current',
  initial?: { url: string; taskId: string; windowId: number },
) {
  if (initial && (mode !== 'new' || !allowed(initial.url))) fail('INVALID_URL');
  const releasing = release();
  const revision = consentRevision;
  await releasing;
  let tab = await chrome.tabs.get(tabId);
  if (revision !== consentRevision) fail('STOPPED');
  if (tab.incognito) fail('UNSUPPORTED_WINDOW', '不支持无痕窗口');
  if (initial && tab.windowId !== initial.windowId) fail('INVALID_CHAT_SOURCE');
  const taskId = initial?.taskId || crypto.randomUUID();
  if (mode === 'new') {
    tab = await chrome.tabs.create({
      windowId: tab.windowId,
      index: tab.index + 1,
      openerTabId: tab.id,
      url: initial?.url || 'about:blank',
      active: !!initial,
    });
    if (tab.id === undefined) fail('TAB_UNAVAILABLE');
    try {
      await recordTask(taskId, tab.windowId, null, tab.id, true);
    } catch (error) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw error;
    }
    if (revision !== consentRevision) {
      await cleanupTask(taskId).catch(() => {});
      fail('STOPPED');
    }
  }
  if (tab.id === undefined) fail('TAB_UNAVAILABLE');
  // Chrome otherwise creates the group in the focused window (possibly the
  // panel's window), moving our explicitly selected tab out of its task window.
  let groupId: number;
  try {
    groupId = await chrome.tabs.group({
      tabIds: [tab.id],
      createProperties: { windowId: tab.windowId },
    });
    await recordTask(taskId, tab.windowId, groupId, tab.id, mode === 'new');
  } catch (error) {
    if (mode === 'new') await cleanupTask(taskId).catch(() => {});
    throw error;
  }
  const session: Scope = {
    scope: 'task',
    windowId: tab.windowId,
    sessionId: taskId,
    groupId,
    tabId: tab.id,
    tabIds: [tab.id],
  };
  if (revision !== consentRevision) {
    await cleanupTask(taskId).catch(() => {});
    fail('STOPPED');
  }
  control = session;
  parked = false;
  publish();
  try {
    await markTask(session, 'working');
    if (control !== session) fail('STOPPED');
    await chrome.action.setBadgeBackgroundColor({ color: '#326C53' });
    if (control !== session) fail('STOPPED');
    await chrome.action.setBadgeText({ text: 'ON' });
    await syncTarget();
    if (control !== session) fail('STOPPED');
  } catch (error) {
    if (control === session) await release();
    throw error;
  }
  return currentGrant();
}
function syncTarget() {
  const session = control;
  return serial(async () => {
    if (!session || control !== session || parked) return;
    const targetId = session.tabId;
    const tab = await chrome.tabs.get(targetId).catch(() => null);
    if (control !== session || parked || session.tabId !== targetId) return;
    if (!tab || !inScope(tab, session)) {
      // No active-tab fallback. Closing/moving/ungrouping the task target revokes
      // control even while it was parked after finish.
      void release();
      fail('TASK_TAB_UNAVAILABLE', '工作标签已关闭或移出任务组，请重新授权');
    }
    if (!inspectable(tab)) {
      await detachCurrent();
      return;
    }
    if (grant?.id === tab.id) {
      if (grant.url !== tab.url) {
        grant.url = tab.url;
        invalidate();
      }
      grant.title = (tab.title || '').slice(0, 500);
      publish();
      return;
    }
    await detachCurrent();
    if (control !== session || parked || session.tabId !== targetId) return;
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    try {
      if (control !== session || parked || session.tabId !== targetId) return;
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable');
      const fresh = await chrome.tabs.get(tab.id);
      if (
        control !== session ||
        session.tabId !== targetId ||
        parked ||
        !inScope(fresh, session) ||
        !inspectable(fresh)
      )
        return;
      grant = {
        id: fresh.id,
        windowId: fresh.windowId,
        url: fresh.url,
        title: (fresh.title || '').slice(0, 500),
      };
      invalidate();
      publish();
    } finally {
      if (grant?.id !== tab.id) await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    }
  });
}
function refreshTaskTarget() {
  void syncTarget().catch(() => {
    if (control) void release();
  });
}
export function initializeExecutor() {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (grant?.id !== source.tabId) return;
    stopCursorHeartbeat();
    cursor = null; // The visual's short TTL also cleans up after external detachment.
    grant = null;
    cdpBinding = null;
    invalidate();
    publish();
    void release(); // Closing the task tab / Chrome Cancel / DevTools ends control.
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== grant?.id) return;
    if (cdpBinding && source.tabId === cdpBinding.tabId && !('sessionId' in source)) {
      // Only the top-page events needed by the engine. Never forward network headers/cookies.
      const eventMethods =
        /^(Page\.(frameNavigated|frameStartedLoading|frameStoppedLoading|lifecycleEvent|loadEventFired|domContentEventFired|navigatedWithinDocument)|Runtime\.(executionContextCreated|executionContextDestroyed|executionContextsCleared)|Network\.(requestWillBeSent|responseReceived|loadingFinished|loadingFailed))$/;
      if (eventMethods.test(method)) {
        let safe = params as Record<string, unknown> | undefined;
        if (method.startsWith('Network.') && safe) {
          const request = safe.request as { url?: string; method?: string } | undefined;
          const response = safe.response as
            { url?: string; status?: number; mimeType?: string } | undefined;
          safe = {
            requestId: safe.requestId,
            timestamp: safe.timestamp,
            type: safe.type,
            ...(request ? { request: { url: request.url, method: request.method } } : {}),
            ...(response
              ? {
                  response: {
                    url: response.url,
                    status: response.status,
                    mimeType: response.mimeType,
                  },
                }
              : {}),
          };
        }
        cdpEvent({ type: 'cdp-event', leaseId: cdpBinding.leaseId, method, params: safe || {} });
      }
    }
    const frame = (params as { frame?: { parentId?: string; url: string } } | undefined)?.frame;
    if (grant && method === 'Page.frameNavigated' && frame && !frame.parentId) {
      stopCursorHeartbeat();
      cursor = null;
      invalidate();
      if (!allowed(frame.url)) refreshTaskTarget();
      else {
        grant.url = frame.url;
        changed(currentGrant());
      }
    }
    if (
      method === 'Runtime.executionContextsCleared' ||
      (method === 'Runtime.executionContextDestroyed' &&
        (params as { executionContextId?: number })?.executionContextId === cursor?.contextId)
    ) {
      stopCursorHeartbeat();
      cursor = null;
    }
  });
  chrome.tabs.onUpdated.addListener((id, info, tab) => {
    if (!control || !control.tabIds.includes(id)) return;
    if (!inScope(tab, control)) {
      if (id === control.tabId) void release();
      else {
        control.tabIds = control.tabIds.filter((t) => t !== id);
        publish();
      }
      return;
    }
    if (grant?.id !== id) {
      if (id === control.tabId && (info.url || info.status === 'complete')) refreshTaskTarget();
      return;
    }
    if (info.url) {
      invalidate();
      if (!allowed(info.url)) {
        refreshTaskTarget();
        return;
      }
      grant.url = info.url;
    }
    if (info.title) grant.title = info.title.slice(0, 500);
    changed(currentGrant());
  });
  // Browser focus is the user's, not an authorization or routing signal.
  const lostTab = (id: number) => {
    if (!control?.tabIds.includes(id)) return;
    if (id === control.tabId) void release();
    else {
      control.tabIds = control.tabIds.filter((t) => t !== id);
      publish();
    }
  };
  chrome.tabs.onDetached.addListener(lostTab);
  chrome.tabs.onRemoved.addListener(lostTab);
  chrome.windows.onRemoved.addListener((id) => {
    if (control?.windowId === id) void release();
  });
}

// Only called by the user's panel button, never exposed as an Agent tool.
export async function revealTask() {
  const session = control;
  if (!session) fail('CONTROL_NOT_GRANTED');
  const tab = await chrome.tabs.get(session.tabId);
  if (control !== session || !inScope(tab, session)) fail('TASK_TAB_UNAVAILABLE');
  await chrome.tabGroups.update(session.groupId, { collapsed: false });
  if (control !== session) fail('STOPPED');
  await chrome.tabs.update(session.tabId, { active: true });
  if (control === session) await chrome.windows.update(session.windowId, { focused: true });
}

export async function bindCdp(request: CdpBind) {
  const session = control;
  if (!session || session.sessionId !== request.controlSessionId) fail('CONTROL_NOT_GRANTED');
  if (Date.now() > request.deadline) fail('COMMAND_EXPIRED');
  parked = false;
  await syncTarget();
  if (control !== session) fail('STOPPED');
  if (Date.now() > request.deadline) fail('COMMAND_EXPIRED');
  if (!grant) fail('NO_CONTROLLABLE_TAB', '请先打开普通网页，或使用 open 导航当前标签');
  await markTask(session, 'working');
  if (control !== session) fail('STOPPED');
  cdpBinding = { leaseId: request.leaseId, controlSessionId: session.sessionId, tabId: grant.id };
  return { ...cdpBinding, url: grant.url, title: grant.title };
}

async function engineCursor(
  lease: GrantedTab,
  action: string,
  point: Partial<Point> = {},
  wait = false,
  nativePoint = false,
  moving = false,
) {
  const binding = cdpBinding;
  const revision = generation;
  const valid = () =>
    !!control && grant === lease && cdpBinding === binding && generation === revision && !parked;
  try {
    if (!valid()) return;
    if (['hide', 'restore'].includes(action) && !cursor) return;
    if (!cursor || cursor.lease !== lease) {
      const tree = (await chrome.debugger.sendCommand(
        { tabId: lease.id },
        'Page.getFrameTree',
      )) as CdpResults['Page.getFrameTree'];
      const world = (await chrome.debugger.sendCommand(
        { tabId: lease.id },
        'Page.createIsolatedWorld',
        {
          frameId: tree.frameTree.frame.id,
          worldName: 'coco-visual-cursor',
        },
      )) as { executionContextId: number };
      if (!valid()) return;
      cursor = {
        lease,
        tabId: lease.id,
        contextId: world.executionContextId,
        owner: crypto.randomUUID(),
      };
    }
    await chrome.debugger.sendCommand({ tabId: lease.id }, 'Runtime.evaluate', {
      contextId: cursor.contextId,
      expression: cursorExpression({
        action,
        owner: cursor.owner,
        ...point,
        waitForArrival: wait,
        animateFromAnchor: true,
        nativePoint,
        moving,
      }),
      awaitPromise: true,
      returnByValue: true,
      timeout: 750,
    });
    if (valid() && cursor && binding && !['hide', 'restore'].includes(action))
      keepEngineCursor(cursor, binding);
  } catch {
    /* Visual feedback must never retry a real action. */
  }
}

async function dispatchPointer(
  params: Record<string, unknown>,
  check: () => void,
  send: (method: keyof CdpResults, params: Record<string, unknown>) => Promise<unknown>,
  show: (action: string, point: Point, moving?: boolean) => Promise<unknown>,
) {
  return pointerMotion.dispatch(params, {
    check,
    send: (point) => send('Input.dispatchMouseEvent', point),
    show,
    viewport: async () => {
      const result = (await send('Runtime.evaluate', {
        expression:
          '({width:innerWidth,height:innerHeight,reducedMotion:matchMedia("(prefers-reduced-motion: reduce)").matches})',
        returnByValue: true,
      })) as { result?: { value?: { width: number; height: number; reducedMotion?: boolean } } };
      if (!result.result?.value) fail('OBSERVATION_UNAVAILABLE');
      return result.result.value;
    },
    hit: async (point) =>
      (await send('DOM.getNodeForLocation', {
        x: Math.floor(point.x),
        y: Math.floor(point.y),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: false,
      })) as { backendNodeId: number; frameId: string },
  });
}

export async function executeCdp(request: CdpRequest) {
  const binding = cdpBinding;
  const lease = grant;
  const session = control;
  const actionRevision = generation;
  const check = () => {
    if (
      !binding ||
      cdpBinding !== binding ||
      !lease ||
      grant !== lease ||
      control !== session ||
      binding.leaseId !== request.leaseId ||
      binding.tabId !== request.tabId ||
      binding.controlSessionId !== request.controlSessionId
    )
      fail('CDP_SESSION_EXPIRED');
    if (Date.now() > request.deadline) fail('COMMAND_EXPIRED');
  };
  check();
  if (!CDP_METHODS.has(request.method) || request.sessionId) fail('CDP_METHOD_NOT_ALLOWED');
  const tab = await chrome.tabs.get(request.tabId);
  check();
  if (!inScope(tab, session) || tab.id !== session?.tabId || !inspectable(tab))
    fail('PAGE_CHANGED');
  if (request.method === 'Page.navigate' && !allowed(String(request.params.url || '')))
    fail('UNSUPPORTED_PAGE');
  if (request.method === 'Page.captureScreenshot' && request.params.captureBeyondViewport === true)
    fail('CDP_METHOD_NOT_ALLOWED', '当前仅允许可见视口截图');
  const target = { tabId: request.tabId };
  let inputPoint: unknown;
  // Keep the existing password / 2FA handoff boundary. The model cannot call raw eval.
  if (request.method === 'Runtime.callFunctionOn' && typeof request.params.objectId === 'string') {
    const focusing =
      typeof request.params.functionDeclaration === 'string' &&
      /^function\(\)\s*\{\s*this\.focus\(\);?\s*\}$/.test(request.params.functionDeclaration);
    const sensitive = (await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
      objectId: request.params.objectId,
      returnByValue: true,
      functionDeclaration: `function(){const e=this; const sensitive=!!(e instanceof Element && e.matches("input[type=password],input[autocomplete=one-time-code]"));
        const r=${focusing} && e instanceof Element ? e.getBoundingClientRect() : null;
        return {sensitive,point:r && r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth ? {x:Math.max(0,r.left)+(Math.min(innerWidth,r.right)-Math.max(0,r.left))/2,y:Math.max(0,r.top)+(Math.min(innerHeight,r.bottom)-Math.max(0,r.top))/2}:null}}`,
    })) as { result?: { value?: { sensitive?: boolean; point?: unknown } } };
    check();
    if (sensitive.result?.value?.sensitive) fail('SENSITIVE_INPUT', '密码和验证码请由用户输入');
    if (focusing) inputPoint = sensitive.result?.value?.point;
  }
  // Tab can move focus into a protected field between keyDown and keyUp.
  // Permit only a text-free release so the key is never left logically pressed.
  const keyRelease =
    request.method === 'Input.dispatchKeyEvent' &&
    request.params.type === 'keyUp' &&
    !request.params.text &&
    !request.params.unmodifiedText;
  if (['Input.insertText', 'Input.dispatchKeyEvent'].includes(request.method) && !keyRelease) {
    const sensitive = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(() => {let e=document.activeElement; while(e?.shadowRoot?.activeElement) e=e.shadowRoot.activeElement;
        const sensitive=!!e?.matches("input[type=password],input[autocomplete=one-time-code]");
        const r=e && e!==document.body && e!==document.documentElement ? e.getBoundingClientRect() : null;
        return {sensitive,point:r && r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth ? {x:Math.max(0,r.left)+(Math.min(innerWidth,r.right)-Math.max(0,r.left))/2,y:Math.max(0,r.top)+(Math.min(innerHeight,r.bottom)-Math.max(0,r.top))/2}:null}})()`,
      returnByValue: true,
    })) as { result?: { value?: { sensitive?: boolean; point?: unknown } } };
    check();
    if (sensitive.result?.value?.sensitive) fail('SENSITIVE_INPUT', '密码和验证码请由用户输入');
    inputPoint = sensitive.result?.value?.point;
  }
  if (inputPoint && typeof inputPoint === 'object' && lease) {
    const { x, y } = inputPoint as Point;
    if (Number.isFinite(x) && Number.isFinite(y))
      await engineCursor(
        lease,
        request.method === 'Input.dispatchKeyEvent' ? 'key' : 'input',
        { x, y },
        true,
      );
  }
  if (request.method === 'Input.dispatchMouseEvent' && lease) {
    const checkMotion = () => {
      check();
      if (generation !== actionRevision) fail('PAGE_CHANGED');
    };
    return dispatchPointer(
      request.params,
      checkMotion,
      async (method, params) => {
        checkMotion();
        const fresh = await chrome.tabs.get(lease.id);
        checkMotion();
        if (
          !inScope(fresh, session) ||
          fresh.id !== session?.tabId ||
          !inspectable(fresh) ||
          fresh.url !== lease.url
        )
          fail('PAGE_CHANGED');
        const result = await chrome.debugger.sendCommand(target, method, params);
        checkMotion();
        return result || {};
      },
      (action, point, moving) => engineCursor(lease, action, point, false, true, moving),
    );
  }
  const capture = request.method === 'Page.captureScreenshot';
  if (capture && cursor && lease) await engineCursor(lease, 'hide');
  try {
    check();
    if (
      inputPoint &&
      ['Input.insertText', 'Input.dispatchKeyEvent'].includes(request.method) &&
      !keyRelease
    ) {
      // The user/page can change focus while the visual is moving. Recheck the
      // protected-field boundary immediately before delivering text or keys.
      const fresh = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression:
          '(() => {let e=document.activeElement; while(e?.shadowRoot?.activeElement) e=e.shadowRoot.activeElement; return !!e?.matches("input[type=password],input[autocomplete=one-time-code]")})()',
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      check();
      if (fresh.result?.value === true) fail('SENSITIVE_INPUT', '密码和验证码请由用户输入');
    }
    // A page can navigate while the UI pointer is arriving. Never dispatch an
    // old coordinate/text action into the new document after that visual wait.
    if (
      generation !== actionRevision &&
      ((request.method.startsWith('Input.') &&
        !keyRelease &&
        request.params.type !== 'mouseReleased') ||
        inputPoint)
    )
      fail('PAGE_CHANGED');
    const result = await chrome.debugger.sendCommand(target, request.method, request.params);
    check();
    return result || {};
  } finally {
    if (capture && cursor && lease && cdpBinding === binding) await engineCursor(lease, 'restore');
  }
}

export async function execute(command: Command, deadline: number) {
  if (command.op === 'finalize') {
    if (Date.now() > deadline) fail('COMMAND_EXPIRED');
    if (control && control.sessionId !== command.taskId)
      fail('STALE_TASK', '该任务已经结束，不能清理另一个任务');
    if (control && command.keep.some((id) => !control!.tabIds.includes(id)))
      fail('TAB_NOT_GRANTED');
    await release(false, true);
    const result = await cleanupTask(command.taskId, command.keep);
    publish();
    return result;
  }
  if (command.op === 'finish' || command.op === 'pause') {
    cdpBinding = null;
    const session = control;
    if (Date.now() > deadline) fail('COMMAND_EXPIRED');
    parked = true;
    invalidate();
    await serial(() => detachCurrent(true));
    if (control !== session) fail('STOPPED');
    if (session) await markTask(session, 'paused').catch(() => {});
    if (Date.now() > deadline) fail('COMMAND_EXPIRED');
    await chrome.action.setBadgeText({ text: '' });
    clearTimeout(pauseTimer);
    if (session)
      pauseTimer = setTimeout(
        () => {
          if (control === session && parked) void release();
        },
        10 * 60 * 1000,
      );
    return { finished: true, debuggerDetached: true };
  }
  if (command.op === 'stop') {
    await release();
    return { stopped: true };
  }
  const session = control;
  if (!session) {
    if (command.op === 'tabs') return { tabs: [], control: null };
    fail('CONTROL_NOT_GRANTED', '请在插件中创建或授权 Agent 工作标签');
  }
  const checkSession = () => {
    if (control !== session) fail('STOPPED');
    if (Date.now() > deadline) fail('COMMAND_EXPIRED');
  };
  if (command.op === 'tabs') {
    const tabs = await chrome.tabs.query({ windowId: session.windowId });
    checkSession();
    return {
      control: currentControl(),
      tabs: tabs
        .filter((t) => inScope(t, session) && inspectable(t))
        .map((t) => ({
          id: t.id,
          url: t.url,
          title: (t.title || '').slice(0, 500),
          active: t.active,
          selected: t.id === session.tabId,
        })),
    };
  }
  if (command.op === 'open' || command.op === 'new-tab' || command.op === 'switch-tab') {
    checkSession();
    if (command.op !== 'switch-tab' && !allowed(command.url))
      fail('UNSUPPORTED_PAGE', '只允许普通 HTTP/HTTPS 网页');
    parked = false;
    let target;
    if (command.op === 'new-tab') {
      if (session.tabIds.length >= 8) fail('TASK_TAB_LIMIT', '单个任务最多 8 个工作标签');
      target = await chrome.tabs.create({
        windowId: session.windowId,
        url: command.url,
        active: false,
      });
      if (target.id === undefined) fail('TAB_UNAVAILABLE');
      try {
        await recordTask(session.sessionId, session.windowId, session.groupId, target.id, true);
        checkSession();
        await chrome.tabs.group({ tabIds: [target.id], groupId: session.groupId });
        checkSession();
        session.tabIds.push(target.id);
      } catch (error) {
        // This ID was just created by this call, not a user tab or a new task's target.
        await chrome.tabs.remove(target.id).catch(() => {});
        throw error;
      }
    } else {
      const tab =
        command.op === 'switch-tab'
          ? await chrome.tabs.get(command.tabId)
          : await chrome.tabs.get(session.tabId);
      checkSession();
      if (!tab || tab.id === undefined || !inScope(tab, session))
        fail('TAB_NOT_GRANTED', '只能操作已明确授权的 Agent 工作标签');
      if (command.op === 'switch-tab' && !inspectable(tab)) fail('UNSUPPORTED_PAGE');
      target = command.op === 'open' ? await chrome.tabs.update(tab.id, { url: command.url }) : tab;
    }
    if (!target) fail('TAB_UNAVAILABLE');
    checkSession();
    if (target.id === undefined) fail('TAB_UNAVAILABLE');
    session.tabId = target.id;
    invalidate();
    publish();
    await syncTarget();
    checkSession();
    await markTask(session, 'working');
    checkSession();
    return {
      tabId: target.id,
      url: command.op === 'switch-tab' ? target.url : command.url,
      navigating: command.op !== 'switch-tab',
    };
  }
  parked = false;
  await syncTarget();
  checkSession();
  if (!grant) fail('NO_CONTROLLABLE_TAB', '当前页不可操作；可用 open 打开普通网站，无需再次授权');
  await chrome.action.setBadgeText({ text: 'ON' });
  await markTask(session, 'working');
  checkSession();
  const lease = grant;
  const startGeneration = generation;
  const check = () => {
    checkSession();
    if (Date.now() > deadline) fail('COMMAND_EXPIRED');
    if (grant !== lease) fail('STOPPED');
    if (generation !== startGeneration) fail('PAGE_CHANGED', '页面已变化，请重新 snapshot');
  };
  async function cdp<M extends keyof CdpResults>(
    method: M,
    params: Record<string, unknown> = {},
  ): Promise<CdpResults[M]> {
    if (method === 'Input.dispatchMouseEvent')
      return (await dispatchPointer(params, check, sendCdp, (action, point, moving) =>
        showCursor(action, point, false, true, moving),
      )) as CdpResults[M];
    return sendCdp(method, params);
  }
  async function sendCdp<M extends keyof CdpResults>(
    method: M,
    params: Record<string, unknown> = {},
  ): Promise<CdpResults[M]> {
    check();
    const tab = await chrome.tabs.get(lease.id);
    check();
    if (!inScope(tab, session) || tab.id !== session?.tabId || !inspectable(tab)) {
      invalidate();
      refreshTaskTarget();
      fail('PAGE_CHANGED');
    }
    if (tab.url !== lease.url) {
      invalidate();
      fail('PAGE_CHANGED', '页面已变化，请重新 snapshot');
    }
    const result = await chrome.debugger.sendCommand({ tabId: lease.id }, method, params);
    check();
    return result as CdpResults[M];
  }
  async function call<A extends keyof DomResults>(
    objectId: string,
    action: A,
    args: unknown[] = [],
  ): Promise<DomResults[A]> {
    const response = await cdp('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: domActionSource,
      arguments: [action, ...args].map((value) => ({ value })),
      returnByValue: true,
    });
    if (response.exceptionDetails)
      fail(
        'ELEMENT_ERROR',
        response.exceptionDetails.exception?.description?.split('\n')[0] ||
          'Element cannot be used',
      );
    return response.result.value as DomResults[A];
  }
  async function showCursor(
    action: string,
    point: Partial<Point> = {},
    waitForArrival = false,
    nativePoint = false,
    moving = false,
  ) {
    // Visual feedback is best-effort; it must not retry or change a browser action.
    try {
      if (!cursor || cursor.lease !== lease) {
        const { frameTree } = await cdp('Page.getFrameTree');
        const { executionContextId } = await cdp('Page.createIsolatedWorld', {
          frameId: frameTree.frame.id,
          worldName: 'coco-visual-cursor',
        });
        cursor = {
          lease,
          tabId: lease.id,
          contextId: executionContextId,
          owner: crypto.randomUUID(),
        };
      }
      const response = await cdp('Runtime.evaluate', {
        contextId: cursor.contextId,
        expression: cursorExpression({
          action,
          owner: cursor.owner,
          ...point,
          waitForArrival,
          nativePoint,
          moving,
        }),
        awaitPromise: true,
        returnByValue: true,
        timeout: 750,
      });
      if (response.exceptionDetails) return false;
      return true;
    } catch {
      check();
      return false;
    }
  }
  async function preview(action: string, point: Point) {
    // Wait for a bounded, cancellable movement acknowledgement, not a fixed sleep.
    // First appearance, same-position actions and reduced motion resolve immediately.
    await showCursor(action, point, true);
    check();
  }
  async function element(ref: string) {
    const entry = refs.get(ref);
    if (!entry || entry.generation !== generation)
      fail('STALE_ELEMENT', '请重新 snapshot 获取元素引用');
    try {
      const resolved = await cdp('DOM.resolveNode', {
        backendNodeId: entry.backendNodeId,
        objectGroup: 'coco-browser',
      });
      await call(resolved.object.objectId, 'validate');
      return resolved.object.objectId;
    } catch (error) {
      fail(
        error instanceof Error && 'code' in error ? String(error.code) : 'STALE_ELEMENT',
        error instanceof Error ? error.message : 'Element unavailable',
      );
    }
  }
  async function snapshot(interactiveOnly: boolean) {
    refs.clear();
    await cdp('Runtime.releaseObjectGroup', { objectGroup: 'coco-browser' });
    const { nodes } = await cdp('Accessibility.getFullAXTree');
    const serial = crypto.randomUUID().slice(0, 8);
    const interactive = new Set([
      'button',
      'link',
      'textbox',
      'searchbox',
      'combobox',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'menuitem',
      'slider',
      'spinbutton',
    ]);
    const lines = [
      `URL: ${lease.url}`,
      `Title: ${lease.title}`,
      `Tab: ${lease.id}`,
      'Scope: selected Agent work tab, top document. User focus changes do not change the task target. Cross-site navigation keeps this control session.',
    ];
    let count = 0;
    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value || '';
      if (interactiveOnly && !interactive.has(role)) continue;
      if (!role || (!node.name?.value && !interactive.has(role))) continue;
      if (++count > 600) {
        lines.push('[truncated: 600 nodes]');
        break;
      }
      const ref = `@${serial}-e${count}`;
      if (node.backendDOMNodeId)
        refs.set(ref, { backendNodeId: node.backendDOMNodeId, generation });
      lines.push(
        `${node.backendDOMNodeId ? ref : '-'} ${role} ${JSON.stringify(String(node.name?.value || '').slice(0, 400))}`,
      );
    }
    return { text: lines.join('\n') };
  }
  async function screenshot() {
    if (cursor) await showCursor('hide');
    try {
      const result = await cdp('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      // Leave room for AX text and the JSON envelope under the bridge's 8 MiB limit.
      if (result.data.length > 7_000_000)
        fail('SCREENSHOT_TOO_LARGE', '截图过大，请缩小浏览器窗口后重新观察');
      // Also validate the active target after capture; never return a different tab's pixels.
      await cdp('Page.getLayoutMetrics');
      return result;
    } finally {
      if (cursor && control === session && grant === lease)
        await showCursor('restore').catch(() => {});
    }
  }
  if (command.op === 'snapshot') return snapshot(command.interactive);
  if (command.op === 'screenshot') return screenshot();
  if (command.op === 'observe') {
    const tab = await chrome.tabs.get(lease.id);
    check();
    if (tab.status === 'loading' || tab.pendingUrl)
      fail('PAGE_LOADING', '页面正在加载；稍后重新 observe，不要重放之前的操作');
    const { frameTree } = await cdp('Page.getFrameTree');
    const { executionContextId } = await cdp('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'coco-observation',
    });
    // A local read-only probe, not a remotely callable arbitrary evaluation tool.
    const state = await cdp('Runtime.evaluate', {
      contextId: executionContextId,
      expression:
        '({readyState:document.readyState,width:innerWidth,height:innerHeight,scrollX,scrollY,dpr:devicePixelRatio})',
      returnByValue: true,
      timeout: 500,
    });
    const viewport = state.result?.value as
      | {
          readyState: string;
          width: number;
          height: number;
          scrollX: number;
          scrollY: number;
          dpr: number;
        }
      | undefined;
    if (state.exceptionDetails || !viewport || !Number.isFinite(viewport.width))
      fail('OBSERVATION_UNAVAILABLE');
    if (viewport.readyState === 'loading') fail('PAGE_LOADING');
    const startedAt = new Date().toISOString();
    try {
      const { text } = await snapshot(command.interactive);
      const { data } = await screenshot();
      const fresh = await chrome.tabs.get(lease.id);
      check();
      if (fresh.status === 'loading' || fresh.pendingUrl) fail('PAGE_LOADING');
      return {
        observationId: crypto.randomUUID(),
        tabId: lease.id,
        url: lease.url,
        title: lease.title,
        pageVersion: `${session.sessionId}:${startGeneration}`,
        startedAt,
        capturedAt: new Date().toISOString(),
        viewport,
        text,
        screenshot: { mimeType: 'image/png' as const, data },
      };
    } catch (error) {
      // An incomplete observation must not leave a usable new ref set behind.
      refs.clear();
      throw error;
    }
  }
  if (command.op === 'scroll') {
    const { cssLayoutViewport: v } = await cdp('Page.getLayoutMetrics');
    return cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.floor(v.clientWidth / 2),
      y: Math.floor(v.clientHeight / 2),
      deltaX:
        command.direction === 'right'
          ? command.pixels
          : command.direction === 'left'
            ? -command.pixels
            : 0,
      deltaY:
        command.direction === 'down'
          ? command.pixels
          : command.direction === 'up'
            ? -command.pixels
            : 0,
    });
  }
  if (command.op === 'keypress') {
    const keys = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
    };
    if (!keys[command.key]) fail('INVALID_KEY');
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: command.key,
      code: command.key,
      windowsVirtualKeyCode: keys[command.key],
      ...(command.key === 'Enter' ? { text: '\r' } : {}),
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: command.key,
      code: command.key,
      windowsVirtualKeyCode: keys[command.key],
    });
    return { pressed: command.key };
  }
  if (command.op === 'click' || command.op === 'fill' || command.op === 'type') {
    const objectId = await element(command.ref);
    if (command.op === 'click') {
      const point = await call(objectId, 'point', [true]);
      // dispatchPointer performs the real movement and re-hit-tests before pressing.
      await cdp('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...point,
        button: 'left',
        clickCount: 1,
      });
      await cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...point,
        button: 'left',
        clickCount: 1,
      });
    } else {
      const point = await call(objectId, 'prepare-input', [command.op === 'fill']);
      await preview('input', point);
      await call(objectId, 'check-focus');
      await cdp('Input.insertText', { text: command.text });
    }
    return { done: true };
  }
  fail('UNSUPPORTED_COMMAND');
}
