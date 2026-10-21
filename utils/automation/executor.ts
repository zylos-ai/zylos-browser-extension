import { PageActions, type ElementRef, type Target } from './page-actions';
import {
  diagnosticSend,
  diagnosticAttach,
  diagnosticDetach,
  recordDebuggerEvent,
  setDiagnosticTarget,
  refreshCdpDiagnostics,
  recordControlDiagnostic,
  recordGroupDiagnostic,
} from './cdp-diagnostics';
import { NetworkActivity, waitForStablePage } from './page-stability';
import { frameEvent, frameSessions, enableFrames, clearFrameSessions } from './frames';
import { isBlockedUrl } from '../guard';
import { cursorExpression } from './cursor';
import { cleanupTask, recordTask } from './task-lifecycle';
import { PointerMotion } from './pointer-motion';
import type { Command } from '../commands';
import type { CdpResults, Cursor, GrantedTab, Point, Scope } from './types';
import {
  canReadPage,
  assertPageDocument,
  getPageDocument,
  type PageDocument,
} from '../page-reader';
import { recoveryFrameScript, type RecoveryFrameInspection } from './recovery-frames';
import { screenshotAttachment } from '../attachments';
import { translate, workerLocale } from '../i18n';
import { recordDiagnostic, type DiagnosticReason } from '../diagnostics';
import {
  CONTROL_RECOVERY_WINDOW_MS,
  CONTROL_RECOVERY_ATTEMPT_MS,
  recoveryBudgetAvailable,
  type ControlRecovery,
  type RecoveryOutcome,
} from '../control-loss';

let grant: GrantedTab | null = null;
const pointerMotion = new PointerMotion();
let cursor: Cursor | null = null;
let control: Scope | null = null;
let parked = false;
let pauseTimer: ReturnType<typeof setTimeout> | undefined;
let attachmentQueue: Promise<unknown> = Promise.resolve();
let consentRevision = 0;
let operationRevision = 0;
let lossRevision = 0;
let grantedDocument: PageDocument | undefined;
type RecoveryLease = ControlRecovery & {
  session: Scope;
  url: string;
  tabId: number;
  consent: number;
  attempted: boolean;
  terminalOutcome?: RecoveryOutcome;
  timer: ReturnType<typeof setTimeout>;
  document?: PageDocument;
  inspectionWork?: Promise<RecoveryFrameInspection>;
  removal?: { nonce: string; deadline: number; authorized: boolean };
};
let recovery: RecoveryLease | undefined;
let initializingFrames: { tabId: number; valid: () => boolean } | undefined;
const recoveryAttempts = new WeakMap<Scope, number[]>();
// An unconfirmed late detach must not let a later task inherit the old debugger.
const blockedAttachments = new Set<number>();
let recoveryHooks:
  | {
      enabled: () => boolean;
      frameSelectionEnabled?: () => boolean;
      onSuspended: (value: ControlRecovery) => void;
      onRevoked: (outcome: RecoveryOutcome) => void;
    }
  | undefined;
export function configureControlRecovery(hooks: typeof recoveryHooks) {
  recoveryHooks = hooks;
}
export const currentControlRecovery = (): ControlRecovery | undefined =>
  recovery && {
    recoveryId: recovery.recoveryId,
    expiresAt: recovery.expiresAt,
    reason: recovery.reason,
    cause: recovery.cause,
    ...(recovery.frameSelection ? { frameSelection: true as const } : {}),
    ...(recovery.inspection ? { inspection: recovery.inspection } : {}),
  };
export function abortControlRecovery(outcome: RecoveryOutcome = 'revoked') {
  if (recovery) {
    recovery.terminalOutcome = outcome;
    void release(true, false, 'target_unavailable').catch(() => {});
  }
}
function suspendControl() {
  if (
    !control ||
    !grant ||
    !recoveryBudgetAvailable(recoveryAttempts.get(control) ?? []) ||
    !recoveryHooks?.enabled()
  )
    return false;
  const lease: RecoveryLease = {
    recoveryId: crypto.randomUUID(),
    expiresAt: Date.now() + CONTROL_RECOVERY_WINDOW_MS,
    reason: 'target_closed',
    cause: 'unknown',
    session: control,
    url: grant.url,
    tabId: grant.id,
    consent: consentRevision,
    attempted: false,
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
    ...(recoveryHooks?.frameSelectionEnabled?.() &&
    grantedDocument?.tabId === grant.id &&
    grantedDocument.url === grant.url
      ? { document: grantedDocument, frameSelection: true as const }
      : {}),
  };
  recovery = lease;
  grant = null;
  cursor = null;
  parked = true;
  lossRevision++;
  operationRevision++;
  clearFrameSessions();
  invalidate('debugger_detach');
  lease.timer = setTimeout(() => {
    if (recovery === lease) abortControlRecovery('expired');
  }, CONTROL_RECOVERY_WINDOW_MS);
  publish();
  recoveryHooks?.onSuspended(currentControlRecovery()!);
  return true;
}
export const controlLossRevision = () => lossRevision;
const refs = new Map<string, ElementRef>();
const networkActivity = new NetworkActivity();
let pendingScroll: Target | undefined;
let dialog: {
  tabId: number;
  sessionId?: string;
  type: string;
  message: string;
  defaultPrompt: string;
} | null = null;
let dragData: unknown = null;
let popupQueue: Promise<unknown> = Promise.resolve();
const newPopups: number[] = [];
const popupSources = new Map<number, { sessionId: string; opener: number }>();
export const taskPopupOpener = (id: number) =>
  popupSources.get(id)?.sessionId === control?.sessionId ? popupSources.get(id)?.opener : undefined;

let generation = 0;
// Track navigation separately from ref invalidation and debugger attachment.
let navigationRevision = 0;
export const diagnosticNavigationRevision = () => navigationRevision;
let changed: (tab: GrantedTab | null) => void = () => {};
function fail(code: string, message = code): never {
  if (code === 'STOPPED')
    recordDiagnostic('stopped', 'other', { source: 'executor', level: 'warn' });
  throw Object.assign(new Error(message), { code });
}
function stopped(reason: DiagnosticReason): never {
  recordDiagnostic('stopped', reason, { source: 'executor', level: 'warn' });
  throw Object.assign(new Error('STOPPED'), { code: 'STOPPED' });
}
export const currentGrant = () => (control && grant ? { ...grant } : null);
export const currentControl = () => (control ? { ...control, tabIds: [...control.tabIds] } : null);
export const browserPageVersion = () =>
  `${control?.sessionId}:${control?.tabId}:${navigationRevision}`;
export const flushTaskPopups = () => popupQueue;
export const onState = (fn: typeof changed) => {
  changed = fn;
};
function invalidate(reason: DiagnosticReason = 'other') {
  recordDiagnostic('invalidate', reason, { source: 'executor', level: 'debug' });
  generation++;
  refs.clear();
  pendingScroll = undefined;
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
const publish = () => {
  refreshCdpDiagnostics();
  changed(currentGrant());
};
const inScope = (tab: chrome.tabs.Tab, session: Scope | null) =>
  !!session &&
  tab.windowId === session.windowId &&
  !tab.incognito &&
  tab.id !== undefined &&
  session.tabIds.includes(tab.id) &&
  (tab.id === session.borrowedTabId ||
    (session.groupId !== null && tab.groupId === session.groupId));
let groupUpdates: Promise<unknown> = Promise.resolve();
const missingGroup = (error: unknown) =>
  error instanceof Error && /^No (?:tab )?group with id:/.test(error.message);
function forgetGroup(session: Scope, groupId: number) {
  if (control !== session || session.groupId !== groupId) return;
  recordGroupDiagnostic('removed');
  session.groupId = null;
  if (session.tabId !== session.borrowedTabId) {
    void release(true, false, 'tab_scope_changed').catch(() => {});
    return;
  }
  session.tabIds = session.tabIds.filter((id) => id === session.borrowedTabId);
  publish();
}
function markTask(session: Scope, phase: Scope['phase']) {
  if (control === session) {
    session.phase = phase;
    publish();
  }
  const next = groupUpdates
    .catch(() => {})
    .then(async () => {
      if (control !== session || session.groupId === null) return;
      const groupId = session.groupId;
      try {
        await chrome.tabGroups.update(groupId, {
          color: phase === 'ready' ? 'green' : 'grey',
          title: 'zylos',
        });
      } catch (error) {
        recordGroupDiagnostic('presentation-failed');
        if (chrome.tabGroups.get) {
          try {
            await chrome.tabGroups.get(groupId);
          } catch (lookupError) {
            if (missingGroup(lookupError)) forgetGroup(session, groupId);
          }
        } else if (missingGroup(error)) forgetGroup(session, groupId);
      }
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

async function groupOwnedTab(session: Scope, tabId: number) {
  if (recovery) fail('CONTROL_SUSPENDED');
  if (control !== session) stopped('control_changed');
  if (session.groupId !== null && chrome.tabGroups.get) {
    const oldGroup = session.groupId;
    try {
      await chrome.tabGroups.get(oldGroup);
    } catch (error) {
      if (!missingGroup(error)) throw error;
      forgetGroup(session, oldGroup);
    }
    if (control !== session) stopped('control_changed');
  }
  if (recovery) fail('CONTROL_SUSPENDED');
  const groupId = await chrome.tabs.group({
    tabIds: [tabId],
    ...(session.groupId === null
      ? { createProperties: { windowId: session.windowId } }
      : { groupId: session.groupId }),
  });
  if (control !== session) stopped('control_changed');
  session.groupId = groupId;
  await recordTask(session.sessionId, session.windowId, groupId, tabId, true);
}

/** Borrow the page attached to a user message; never navigate, regroup or own it. */
export async function useExistingTab(
  expected: { tabId: number; windowId: number; url: string; documentId?: string },
  assertActive: () => void,
) {
  if (recovery) fail('CONTROL_SUSPENDED');
  const tab = await chrome.tabs.get(expected.tabId).catch(() => null);
  assertActive();
  if (!tab || tab.windowId !== expected.windowId || !canReadPage(tab))
    fail('TAB_NOT_GRANTED', 'The shared page is closed, restricted or unavailable');
  if (tab.url !== expected.url)
    fail('PAGE_CHANGED', 'The shared page navigated; ask for a new message from the current page');
  if (expected.documentId)
    await assertPageDocument({ ...expected, documentId: expected.documentId });
  assertActive();
  if (!inScope(tab, control)) {
    // Changing targets hands previous results back instead of closing them.
    const finishing = completeTask();
    const revision = consentRevision;
    await finishing;
    assertActive();
    if (revision !== consentRevision) stopped('consent_changed');
    const session: Scope = {
      scope: 'task',
      phase: 'ready',
      windowId: tab.windowId,
      sessionId: crypto.randomUUID(),
      groupId: null,
      borrowedTabId: expected.tabId,
      tabId: expected.tabId,
      tabIds: [expected.tabId],
    };
    await recordTask(session.sessionId, session.windowId, null, expected.tabId, false);
    if (revision !== consentRevision) {
      await cleanupTask(session.sessionId).catch(() => {});
      stopped('consent_changed');
    }
    assertActive();
    control = session;
  }
  const session = control!;
  session.tabId = expected.tabId;
  parked = false;
  try {
    await syncTarget();
    assertActive();
    if (control !== session) stopped('control_changed');
    if (grant?.id !== expected.tabId) stopped('grant_changed');
    if (expected.documentId)
      await assertPageDocument({ ...expected, documentId: expected.documentId });
    assertActive();
    if (control !== session) stopped('control_changed');
    const fresh = await chrome.tabs.get(expected.tabId);
    if (control !== session) stopped('control_changed');
    if (!inScope(fresh, session)) stopped('tab_scope_changed');
    if (!canReadPage(fresh) || fresh.url !== expected.url) fail('PAGE_CHANGED');
    await markTask(session, 'ready');
    assertActive();
    if (control !== session) stopped('control_changed');
    return {
      selected: true,
      tabId: expected.tabId,
      url: expected.url,
      borrowed: session.borrowedTabId === expected.tabId,
    };
  } catch (error) {
    if (control === session) await completeTask().catch(() => {});
    throw error;
  }
}
async function detachCurrent(strict = false) {
  grantedDocument = undefined;
  networkActivity.clear();
  const old = grant;
  clearFrameSessions();
  dialog = null;
  dragData = null;
  grant = null;
  invalidate('target_detach');
  publish();
  await clearCursor();
  if (old) {
    try {
      await diagnosticDetach({ tabId: old.id });
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
  const previous = cursor;
  cursor = null;
  if (!previous) return;
  await diagnosticSend({ tabId: previous.tabId }, 'Runtime.evaluate', {
    contextId: previous.contextId,
    expression: cursorExpression({ action: 'remove', owner: previous.owner }),
    returnByValue: true,
    timeout: 500,
  }).catch(() => {});
}
export async function release(cleanup = true, strict = false, reason: DiagnosticReason = 'other') {
  const suspended = recovery;
  recovery = undefined;
  if (suspended?.document && suspended.frameSelection) {
    void chrome.scripting
      .executeScript({
        target: { tabId: suspended.tabId, documentIds: [suspended.document.documentId] },
        world: 'ISOLATED',
        func: recoveryFrameScript,
        args: [
          {
            action: 'revoke',
            recoveryId: suspended.recoveryId,
            expiresAt: 0,
            ownId: chrome.runtime.id,
            url: suspended.url,
          },
        ],
      })
      .catch(() => {});
  }
  if (suspended) clearTimeout(suspended.timer);
  recordControlDiagnostic(reason);
  recordDiagnostic('release', reason, { source: 'executor' });
  clearTimeout(pauseTimer);

  const previous = control;
  if (
    previous &&
    [
      'debugger_detach',
      'target_unavailable',
      'target_refresh_failed',
      'tab_scope_changed',
      'tab_lost',
      'window_closed',
      'pause_timeout',
      'panel_stop',
      'config_disabled',
      'command_stop',
    ].includes(reason)
  )
    lossRevision++;
  // Revoke synchronously: queued or in-flight attachments cannot revive consent.
  control = null;
  initializingFrames = undefined;
  clearFrameSessions();
  newPopups.length = 0;
  popupSources.clear();
  parked = true;
  consentRevision++;
  operationRevision++;
  invalidate('release');
  publish();
  if (suspended) recoveryHooks?.onRevoked(suspended.terminalOutcome ?? 'revoked');
  try {
    await serial(() => detachCurrent(strict));
    // Closing temporary tabs / ungrouping retained pages removes an empty group.
    if (previous && cleanup) await cleanupTask(previous.sessionId).catch(() => {});
  } finally {
    if (!control) await chrome.action.setBadgeText({ text: '' });
    publish();
  }
}

/** A final answer hands the open pages back to the owner and ends browser control. */
export async function completeTask() {
  const previous = currentControl();
  // Revoke immediately, including a task that is still being created.
  const releasing = release(false, true, 'task_complete');
  // Persist retained tabs even if debugger detachment fails, so recovery cannot close them.
  await Promise.all([
    releasing,
    previous ? cleanupTask(previous.sessionId, previous.tabIds) : Promise.resolve(),
  ]);
}
// The Remote dispatcher supplies a verified source window; every task gets a new tab.
export async function createTask(initial: {
  sourceTabId: number;
  windowId: number;
  url: string;
  taskId: string;
}) {
  if (recovery) fail('CONTROL_SUSPENDED');
  if (!allowed(initial.url)) fail('INVALID_URL');
  const releasing = release();
  const revision = consentRevision;
  await releasing;
  const source = await chrome.tabs.get(initial.sourceTabId);
  if (revision !== consentRevision) stopped('consent_changed');
  if (source.incognito) fail('UNSUPPORTED_WINDOW', '不支持无痕窗口');
  if (source.windowId !== initial.windowId) fail('INVALID_TASK_SOURCE');
  const taskId = initial.taskId;
  const tab = await chrome.tabs.create({
    windowId: source.windowId,
    index: source.index + 1,
    openerTabId: source.id,
    url: initial.url,
    active: true,
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
    stopped('consent_changed');
  }
  let groupId: number;
  try {
    groupId = await chrome.tabs.group({
      tabIds: [tab.id],
      createProperties: { windowId: tab.windowId },
    });
    await recordTask(taskId, tab.windowId, groupId, tab.id, true);
  } catch (error) {
    await cleanupTask(taskId).catch(() => {});
    throw error;
  }
  const session: Scope = {
    scope: 'task',
    phase: 'ready',
    windowId: tab.windowId,
    sessionId: taskId,
    groupId,
    tabId: tab.id,
    tabIds: [tab.id],
  };
  if (revision !== consentRevision) {
    await cleanupTask(taskId).catch(() => {});
    stopped('consent_changed');
  }
  control = session;
  parked = false;
  publish();
  try {
    await markTask(session, 'ready');
    if (control !== session) stopped('control_changed');
    await chrome.action.setBadgeBackgroundColor({ color: '#326C53' });
    if (control !== session) stopped('control_changed');
    await chrome.action.setBadgeText({ text: translate(workerLocale(), 'browserBadge') });
    await syncTarget();
    if (control !== session) stopped('control_changed');
  } catch (error) {
    if (control === session) await release();
    throw error;
  }
  return currentGrant();
}
function syncTarget() {
  const session = control;
  return serial(async () => {
    if (!session || control !== session || parked || recovery) return;
    const targetId = session.tabId;
    const tab = await chrome.tabs.get(targetId).catch(() => null);
    if (control !== session || parked || session.tabId !== targetId) return;
    if (!tab || !inScope(tab, session)) {
      // No active-tab fallback. Closing/moving/ungrouping the task target revokes
      // control even while it was parked after finish.
      void release(true, false, 'target_unavailable');
      fail('TASK_TAB_UNAVAILABLE', '工作标签已关闭或移出任务组，请重新创建任务');
    }
    if (!inspectable(tab)) {
      await detachCurrent();
      return;
    }
    if (grant?.id === tab.id) {
      if (grant.url !== tab.url) {
        grant.url = tab.url;
        invalidate('navigation');
      }
      grant.title = (tab.title || '').slice(0, 500);
      if (recoveryHooks?.frameSelectionEnabled?.()) {
        const document = await getPageDocument(tab).catch(() => undefined);
        if (control !== session || parked || session.tabId !== targetId) return;
        grantedDocument = document;
      }
      publish();
      return;
    }
    await detachCurrent();
    if (control !== session || parked || session.tabId !== targetId) return;
    if (blockedAttachments.has(tab.id)) fail('DEBUGGER_DETACH_FAILED');
    await diagnosticAttach({ tabId: tab.id }, '1.3');
    try {
      if (control !== session || parked || session.tabId !== targetId) return;
      await diagnosticSend({ tabId: tab.id }, 'Page.enable');
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
      if (recoveryHooks?.frameSelectionEnabled?.()) {
        const document = await getPageDocument(fresh).catch(() => undefined);
        if (control !== session || parked || session.tabId !== targetId) return;
        grantedDocument = document;
      }
      invalidate('target_attach');
      await enableFrames({ tabId: tab.id });
      // Keep the controlled renderer active without selecting the user's tab.
      await diagnosticSend({ tabId: tab.id }, 'Emulation.setFocusEmulationEnabled', {
        enabled: true,
      });
      publish();
    } finally {
      if (grant?.id !== tab.id) await diagnosticDetach({ tabId: tab.id }).catch(() => {});
    }
  });
}
function refreshTaskTarget() {
  void syncTarget().catch(() => {
    if (control) void release(true, false, 'target_refresh_failed');
  });
}
export function initializeExecutor() {
  chrome.runtime?.onMessage?.addListener((message, sender, respond) => {
    if (message?.type !== 'recovery-frame-authorize') return;
    const lease = recovery;
    const removal = lease?.removal;
    const valid = () =>
      !!lease &&
      recovery === lease &&
      !!removal &&
      lease.removal === removal &&
      !removal.authorized &&
      recoveryHooks?.frameSelectionEnabled?.() === true &&
      recoveryHooks.enabled() &&
      control === lease.session &&
      consentRevision === lease.consent &&
      lease.attempted &&
      message.recoveryId === lease.recoveryId &&
      message.nonce === removal.nonce &&
      sender.id === chrome.runtime.id &&
      sender.tab?.id === lease.tabId &&
      sender.frameId === 0 &&
      sender.documentId === lease.document?.documentId &&
      sender.url === lease.url &&
      Date.now() < Math.min(removal.deadline, lease.expiresAt);
    if (!valid()) {
      respond({ allowed: false });
      return false;
    }
    void (async () => {
      try {
        const tab = await chrome.tabs.get(lease!.tabId);
        if (!valid() || !inScope(tab, lease!.session)) return false;
        await assertPageDocument(lease!.document!);
        if (!valid()) return false;
        removal!.authorized = true;
        return true;
      } catch {
        return false;
      }
    })().then((allowed) => respond({ allowed }));
    return true;
  });
  chrome.permissions?.onRemoved?.addListener(() => {
    if (recovery) abortControlRecovery();
  });
  setDiagnosticTarget(() => ({
    tabId: control?.tabId,
    controlled: !!control,
    granted: !!grant,
    borrowed: !!control && control.borrowedTabId === control.tabId,
    revision: navigationRevision,
    groupReference: control && control.groupId !== null ? 'assigned' : 'none',
  }));
  chrome.debugger.onDetach.addListener((source, reason) => {
    recordDebuggerEvent('detach', source, reason);
    recordDiagnostic(
      'detach',
      reason === 'target_closed' || reason === 'canceled_by_user' ? reason : 'other',
      { source: 'executor', level: 'warn' },
    );
    if (recovery && source.tabId === recovery.tabId) {
      abortControlRecovery();
      return;
    }
    if (grant?.id !== source.tabId) return;
    if (
      !(source as { sessionId?: string }).sessionId &&
      reason === 'target_closed' &&
      suspendControl()
    )
      return;

    cursor = null; // The visual's short TTL also cleans up after external detachment.
    grant = null;

    invalidate('debugger_detach');
    publish();
    void release(true, false, 'debugger_detach'); // Closing the task tab / Chrome Cancel / DevTools ends control.
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const initialization = initializingFrames;
    const duringRecovery =
      !!initialization && source.tabId === initialization.tabId && initialization.valid();
    if (source.tabId !== grant?.id && !duringRecovery) return;
    const childSource = source as { tabId: number; sessionId?: string };
    const session = control;
    const consent = consentRevision;
    const valid = () =>
      !!session &&
      control === session &&
      session.tabId === source.tabId &&
      consentRevision === consent &&
      (grant?.id === source.tabId ||
        (initializingFrames === initialization && !!initialization?.valid()));
    networkActivity.event(childSource.sessionId || '', method, params);
    frameEvent(childSource, method, params, valid);
    if (duringRecovery) return;
    if (method === 'Input.dragIntercepted') dragData = (params as { data: unknown }).data;
    if (method === 'Page.javascriptDialogOpening') {
      const p = params as { type: string; message: string; defaultPrompt?: string };
      dialog = {
        tabId: source.tabId!,
        sessionId: childSource.sessionId,
        type: p.type,
        message: p.message,
        defaultPrompt: p.defaultPrompt || '',
      };
      publish();
    }
    if (method === 'Page.javascriptDialogClosed') {
      dialog = null;
      publish();
    }
    if (childSource.sessionId) return;
    const frame = (params as { frame?: { parentId?: string; url: string } } | undefined)?.frame;
    if (grant && method === 'Page.frameNavigated' && frame && !frame.parentId) {
      grantedDocument = undefined;
      navigationRevision++;
      refreshCdpDiagnostics();
      cursor = null;
      invalidate('navigation');
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
      cursor = null;
    }
  });
  chrome.tabs.onUpdated.addListener((id, info, tab) => {
    if (
      recovery &&
      id === recovery.tabId &&
      (tab.url !== recovery.url || (tab.pendingUrl && tab.pendingUrl !== recovery.url))
    ) {
      abortControlRecovery();
      return;
    }
    if (!control || !control.tabIds.includes(id)) return;
    if (!inScope(tab, control)) {
      if (id === control.tabId) void release(true, false, 'tab_scope_changed');
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
      grantedDocument = undefined;
      navigationRevision++;
      refreshCdpDiagnostics();
      invalidate('navigation');
      if (!allowed(info.url)) {
        refreshTaskTarget();
        return;
      }
      grant.url = info.url;
    }
    if (info.title) grant.title = info.title.slice(0, 500);
    changed(currentGrant());
  });
  function adoptPopup(id: number, opener: number, verifiedSource = false) {
    const session = control;
    if (!session || recovery || !session.tabIds.includes(opener)) return;
    const work = async () => {
      if (
        control !== session ||
        recovery ||
        session.tabIds.includes(id) ||
        session.tabIds.length >= 8
      )
        return;
      const parent = await chrome.tabs.get(opener).catch(() => null);
      let fresh = await chrome.tabs.get(id).catch(() => null);
      if (
        control !== session ||
        recovery ||
        !parent ||
        !inScope(parent, session) ||
        !fresh ||
        (!verifiedSource && fresh.openerTabId !== opener) ||
        fresh.incognito
      )
        return;
      if (
        fresh.url &&
        fresh.url !== 'about:blank' &&
        (!allowed(fresh.url) || isBlockedUrl(fresh.url))
      )
        return;
      if (fresh.windowId !== session.windowId) {
        await chrome.tabs.move(id, { windowId: session.windowId, index: -1 });
        fresh = await chrome.tabs.get(id);
      }
      if (control !== session || recovery) return;
      await recordTask(session.sessionId, session.windowId, session.groupId, id, true);
      if (control !== session || recovery) {
        if (recovery) return;
        await cleanupTask(session.sessionId).catch(() => {});
        return;
      }
      await groupOwnedTab(session, id);
      if (control !== session || recovery) {
        if (recovery) return;
        await cleanupTask(session.sessionId).catch(() => {});
        return;
      }
      session.tabIds.push(id);
      popupSources.set(id, { sessionId: session.sessionId, opener });
      newPopups.push(id);
      publish();
    };
    popupQueue = popupQueue
      .catch(() => {})
      .then(work)
      .catch(() => {});
  }
  if (chrome.webNavigation?.onCreatedNavigationTarget) {
    // Navigation source is authoritative even for noopener/background tabs;
    // tabs.openerTabId may instead refer to the current foreground tab.
    chrome.webNavigation.onCreatedNavigationTarget.addListener((event) => {
      if (control?.tabIds.includes(event.sourceTabId))
        adoptPopup(event.tabId, event.sourceTabId, true);
    });
  } else {
    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id !== undefined && tab.openerTabId !== undefined && !tab.incognito)
        adoptPopup(tab.id, tab.openerTabId);
    });
  }
  // Browser focus is the user's, not an authorization or routing signal.
  const lostTab = (id: number) => {
    if (!control?.tabIds.includes(id)) return;
    if (id === control.tabId) void release(true, false, 'tab_lost');
    else {
      control.tabIds = control.tabIds.filter((t) => t !== id);
      publish();
    }
  };
  chrome.tabs.onDetached.addListener(lostTab);
  chrome.tabs.onRemoved.addListener(lostTab);
  chrome.tabGroups.onRemoved?.addListener((group) => {
    const session = control;
    if (session) forgetGroup(session, group.id);
  });
  chrome.windows.onRemoved.addListener((id) => {
    if (control?.windowId === id) void release(true, false, 'window_closed');
  });
}

// Only called by the user's panel button, never exposed as an Agent tool.
export async function revealTask() {
  const session = control;
  if (!session) fail('CONTROL_NOT_GRANTED');
  const tab = await chrome.tabs.get(session.tabId);
  if (control !== session || !inScope(tab, session)) fail('TASK_TAB_UNAVAILABLE');
  if (session.groupId !== null && session.tabId !== session.borrowedTabId)
    await chrome.tabGroups.update(session.groupId, { collapsed: false });
  if (control !== session) stopped('control_changed');
  await chrome.tabs.update(session.tabId, { active: true });
  if (control === session) await chrome.windows.update(session.windowId, { focused: true });
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

export async function inspectRecoveryFrames(recoveryId: string, commandDeadline = Infinity) {
  const lease = recovery;
  if (
    !lease ||
    lease.recoveryId !== recoveryId ||
    lease.attempted ||
    !lease.frameSelection ||
    !lease.document ||
    !recoveryHooks?.frameSelectionEnabled?.()
  )
    fail('RECOVERY_UNAVAILABLE');
  const deadline = Math.min(
    lease.expiresAt,
    commandDeadline,
    Date.now() + CONTROL_RECOVERY_ATTEMPT_MS,
  );
  const check = () => {
    if (
      recovery !== lease ||
      control !== lease.session ||
      consentRevision !== lease.consent ||
      !recoveryHooks?.enabled() ||
      !recoveryHooks.frameSelectionEnabled?.() ||
      Date.now() >= deadline
    )
      fail('RECOVERY_UNAVAILABLE');
  };
  check();
  lease.inspectionWork ??= boundedCdp(async () => {
    await assertPageDocument(lease.document!);
    check();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: lease.tabId, documentIds: [lease.document!.documentId] },
      world: 'ISOLATED',
      func: recoveryFrameScript,
      args: [
        {
          action: 'inspect',
          recoveryId,
          expiresAt: lease.expiresAt,
          ownId: chrome.runtime.id,
          url: lease.url,
        },
      ],
    });
    check();
    await assertPageDocument(lease.document!);
    check();
    if (
      result?.documentId !== lease.document!.documentId ||
      result.frameId !== 0 ||
      result.result?.error ||
      !result.result?.inspection
    )
      fail('RECOVERY_UNAVAILABLE');
    lease.inspection = result.result.inspection;
    return lease.inspection;
  }, check);
  try {
    await lease.inspectionWork;
    await assertPageDocument(lease.document);
    check();
    return currentControlRecovery();
  } catch (error) {
    if (recovery === lease) abortControlRecovery(Date.now() >= deadline ? 'expired' : 'failed');
    throw error;
  }
}

export async function recoverControl(
  recoveryId: string,
  commandDeadline = Infinity,
  selectedCandidateIds?: string[],
) {
  const lease = recovery;
  if (!lease || lease.recoveryId !== recoveryId || lease.attempted) fail('RECOVERY_UNAVAILABLE');
  const attempts = recoveryAttempts.get(lease.session) ?? [];
  if (!recoveryBudgetAvailable(attempts)) {
    abortControlRecovery('failed');
    fail('RECOVERY_UNAVAILABLE');
  }
  lease.attempted = true;
  recoveryAttempts.set(lease.session, [...attempts, Date.now()]);
  const deadline = Math.min(
    lease.expiresAt,
    commandDeadline,
    Date.now() + CONTROL_RECOVERY_ATTEMPT_MS,
  );
  const check = () => {
    if (
      !recoveryHooks?.enabled() ||
      recovery !== lease ||
      control !== lease.session ||
      consentRevision !== lease.consent ||
      control.tabId !== lease.tabId ||
      Date.now() >= deadline
    )
      fail('RECOVERY_UNAVAILABLE');
  };
  const checkTab = async () => {
    check();
    const tab = await chrome.tabs.get(lease.tabId);
    check();
    if (
      !inScope(tab, lease.session) ||
      !inspectable(tab) ||
      tab.url !== lease.url ||
      (tab.pendingUrl && tab.pendingUrl !== lease.url) ||
      isBlockedUrl(tab.url)
    )
      fail('RECOVERY_UNAVAILABLE');
    return tab;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = serial(async () => {
    let attached = false;
    let committed = false;
    try {
      await checkTab();
      if (selectedCandidateIds) {
        if (
          !lease.frameSelection ||
          !lease.document ||
          !lease.inspection ||
          !recoveryHooks?.frameSelectionEnabled?.() ||
          !selectedCandidateIds.length ||
          selectedCandidateIds.length > 16 ||
          new Set(selectedCandidateIds).size !== selectedCandidateIds.length ||
          selectedCandidateIds.some(
            (id) => !lease.inspection!.candidates.some((candidate) => candidate.id === id),
          )
        )
          fail('RECOVERY_UNAVAILABLE');
        await assertPageDocument(lease.document);
        check();
        const removal = { nonce: crypto.randomUUID(), deadline, authorized: false };
        lease.removal = removal;
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: lease.tabId, documentIds: [lease.document.documentId] },
          world: 'ISOLATED',
          func: recoveryFrameScript,
          args: [
            {
              action: 'remove',
              recoveryId,
              expiresAt: deadline,
              ownId: chrome.runtime.id,
              url: lease.url,
              selected: selectedCandidateIds,
              nonce: removal.nonce,
            },
          ],
        });
        check();
        if (
          result?.documentId !== lease.document.documentId ||
          result.frameId !== 0 ||
          result.result?.error ||
          result.result?.removed !== selectedCandidateIds.length ||
          !removal.authorized
        )
          fail('RECOVERY_UNAVAILABLE');
        await assertPageDocument(lease.document);
        check();
      }
      if (blockedAttachments.has(lease.tabId)) fail('DEBUGGER_DETACH_FAILED');
      await diagnosticAttach({ tabId: lease.tabId }, '1.3');
      attached = true;
      await checkTab();
      const initialization = {
        tabId: lease.tabId,
        valid: () => {
          try {
            check();
            return true;
          } catch {
            return false;
          }
        },
      };
      initializingFrames = initialization;
      await diagnosticSend({ tabId: lease.tabId }, 'Page.enable');
      check();
      await enableFrames({ tabId: lease.tabId }, initialization.valid);
      check();
      await diagnosticSend({ tabId: lease.tabId }, 'Emulation.setFocusEmulationEnabled', {
        enabled: true,
      });
      check();
      const document = (await diagnosticSend({ tabId: lease.tabId }, 'Page.getFrameTree')).frameTree
        ?.frame;
      check();
      if (typeof document?.id !== 'string' || typeof document?.loaderId !== 'string')
        fail('OBSERVATION_UNAVAILABLE');
      invalidate('target_attach');
      const recoveryGeneration = generation;
      const actions = new PageActions({
        send: async (method, params, sessionId) => {
          await checkTab();
          if (sessionId && frameSessions().get(sessionId)?.tabId !== lease.tabId)
            fail('FRAME_UNAVAILABLE');
          const result = await diagnosticSend(
            { tabId: lease.tabId, ...(sessionId ? { sessionId } : {}) },
            method,
            params,
          );
          check();
          if (generation !== recoveryGeneration) fail('PAGE_CHANGED');
          return result;
        },
        check,
        refs,
        generation: recoveryGeneration,
        mouse: async () => fail('RECOVERY_UNAVAILABLE'),
        preview: async () => fail('RECOVERY_UNAVAILABLE'),
        dragData: () => null,
      });
      const observation = await actions.snapshot(false, [], true);
      if (!observation.nodeCount) fail('OBSERVATION_UNAVAILABLE');
      const freshDocument = (await diagnosticSend({ tabId: lease.tabId }, 'Page.getFrameTree'))
        .frameTree?.frame;
      check();
      if (freshDocument?.id !== document.id || freshDocument?.loaderId !== document.loaderId)
        fail('PAGE_CHANGED');
      const tab = await checkTab();
      grant = {
        id: lease.tabId,
        windowId: tab.windowId,
        url: lease.url,
        title: (tab.title || '').slice(0, 500),
      };
      grantedDocument = lease.document;
      clearTimeout(lease.timer);
      recovery = undefined;
      initializingFrames = undefined;
      parked = false;
      committed = true;
      publish();
      return {
        recovered: true,
        recoveryId,
        observation,
        target: currentGrant(),
        replayed: false,
        ...(selectedCandidateIds
          ? {
              removal: {
                requested: selectedCandidateIds.length,
                removed: selectedCandidateIds.length,
                outcome: 'completed' as const,
              },
            }
          : {}),
      };
    } finally {
      if (initializingFrames?.tabId === lease.tabId) initializingFrames = undefined;
      // The serialized attach queue stays owned until late completion is cleaned up.
      // A newer task cannot attach on this tab before this lease is detached.
      if (attached && !committed)
        await diagnosticDetach({ tabId: lease.tabId }).catch(() => {
          blockedAttachments.add(lease.tabId);
        });
    }
  });
  try {
    return await Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('Recovery attempt expired'), { code: 'RECOVERY_EXPIRED' }),
            ),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } catch (error) {
    if (recovery === lease) abortControlRecovery(Date.now() >= deadline ? 'expired' : 'failed');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function execute(command: Command, deadline: number) {
  if (command.op === 'inspect-recovery-frames')
    return inspectRecoveryFrames(command.recoveryId, deadline);
  if (command.op === 'recover-control')
    return recoverControl(command.recoveryId, deadline, command.selectedCandidateIds);
  if (recovery && !['stop', 'finalize'].includes(command.op)) fail('CONTROL_SUSPENDED');
  const startedOperationRevision = operationRevision;
  if (command.op === 'finalize') {
    if (Date.now() > deadline) fail('COMMAND_EXPIRED');
    if (control && control.sessionId !== command.taskId)
      fail('STALE_TASK', '该任务已经结束，不能清理另一个任务');
    if (control && command.keep.some((id) => !control!.tabIds.includes(id)))
      fail('TAB_NOT_GRANTED');
    await release(false, true, 'finalize');
    const result = await cleanupTask(command.taskId, command.keep);
    publish();
    return result;
  }
  if (command.op === 'finish' || command.op === 'pause') {
    operationRevision++;

    const session = control;
    if (Date.now() > deadline) fail('COMMAND_EXPIRED');
    parked = true;
    invalidate();
    await serial(() => detachCurrent(true));
    if (control !== session) stopped('control_changed');
    if (session)
      await markTask(session, command.op === 'finish' ? 'finished' : 'paused').catch(() => {});
    if (Date.now() > deadline) fail('COMMAND_EXPIRED');
    await chrome.action.setBadgeText({ text: '' });
    clearTimeout(pauseTimer);
    if (session)
      pauseTimer = setTimeout(
        () => {
          if (control === session && parked) void release(true, false, 'pause_timeout');
        },
        10 * 60 * 1000,
      );
    return { finished: true, debuggerDetached: true };
  }
  if (command.op === 'stop') {
    await release(true, false, 'command_stop');
    return { stopped: true };
  }
  const session = control;
  if (!session) {
    if (command.op === 'tabs') return { tabs: [], control: null };
    if (command.op === 'dialog' && command.action === 'get') return { dialog: null };
    fail('CONTROL_NOT_GRANTED', '请先用 open 创建 Agent 工作标签');
  }
  const checkSession = () => {
    if (operationRevision !== startedOperationRevision) stopped('operation_changed');
    if (control !== session) stopped('control_changed');
    if (Date.now() > deadline) fail('COMMAND_EXPIRED');
  };
  if (command.op === 'tabs') {
    await popupQueue;
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
  if (command.op === 'dialog') {
    checkSession();
    const current = dialog;
    if (command.action === 'get') return { dialog: current ? { ...current } : null };
    if (!current || !session.tabIds.includes(current.tabId)) fail('NO_DIALOG');
    await diagnosticSend(
      { tabId: current.tabId, ...(current.sessionId ? { sessionId: current.sessionId } : {}) },
      'Page.handleJavaScriptDialog',
      {
        accept: command.action === 'accept',
        ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
      },
    );
    checkSession();
    if (dialog === current) dialog = null;
    return { handled: true, type: current.type };
  }
  if (command.op === 'wait') {
    await markTask(session, 'ready');
    checkSession();
    const until = Math.min(deadline, Date.now() + command.timeoutMs);
    while (Date.now() < until) {
      checkSession();
      if (dialog) fail('DIALOG_OPEN', `${dialog.type}: ${dialog.message}; use dialog`);
      if (command.condition === 'new-tab') {
        await popupQueue;
        const id = newPopups.find((id) => session.tabIds.includes(id));
        if (id !== undefined) {
          newPopups.splice(newPopups.indexOf(id), 1);
          return { matched: true, tabId: id };
        }
      } else if (command.condition === 'url' || command.condition === 'loaded') {
        const tab = await chrome.tabs.get(session.tabId);
        checkSession();
        if (
          inScope(tab, session) &&
          inspectable(tab) &&
          !isBlockedUrl(tab.url) &&
          tab.status === 'complete' &&
          !tab.pendingUrl &&
          (command.condition !== 'url' || tab.url === command.url)
        )
          return { matched: true, url: tab.url };
      } else {
        try {
          let matches: { ref: string; state: any }[];
          if (command.selector)
            matches = (
              (await execute(
                { op: 'find', selector: command.selector, frameId: command.frameId },
                until,
              )) as { matches: typeof matches }
            ).matches;
          else if (command.ref)
            matches = [
              {
                ref: command.ref,
                state: await execute({ op: 'inspect', ref: command.ref }, until),
              },
            ];
          else {
            const tab = await chrome.tabs.get(session.tabId);
            checkSession();
            if (!inScope(tab, session) || !inspectable(tab)) fail('PAGE_LOADING');
            if (isBlockedUrl(tab.url)) fail('BLOCKED_URL');
            parked = false;
            await syncTarget();
            checkSession();
            const version = generation;
            const verify = () => {
              checkSession();
              if (generation !== version) fail('PAGE_CHANGED');
            };
            const actions = new PageActions({
              send: (method, params = {}, sessionId) => {
                verify();
                return boundedCdp(
                  () =>
                    diagnosticSend(
                      { tabId: session.tabId, ...(sessionId ? { sessionId } : {}) },
                      method,
                      params,
                    ),
                  verify,
                );
              },
              check: verify,
              refs,
              generation,
              mouse: async () => {},
              preview: async () => {},
              dragData: () => null,
            });
            for (const frame of await actions.safeFrames()) {
              if (command.frameId && frame.id !== command.frameId) continue;
              if (await actions.query(frame, 'text', command.text))
                return { matched: true, frameId: frame.id };
            }
            matches = [];
          }
          const condition = command.condition;
          const match = matches.find(
            ({ state }) =>
              condition === 'attached' ||
              (condition === 'visible' && state.visible) ||
              (condition === 'enabled' && state.visible && !state.disabled) ||
              (condition === 'clickable' && state.clickable) ||
              (condition === 'checked' && state.checked === (command.checked ?? true)) ||
              (condition === 'text' && state.text?.includes(command.text!)),
          );
          if (match) return { matched: true, ...match };
          if (
            (condition === 'detached' && !matches.length) ||
            (condition === 'hidden' && matches.every((m) => !m.state.visible))
          )
            return { matched: true };
          if (command.selector) for (const match of matches) refs.delete(match.ref);
        } catch (error) {
          checkSession();
          const code = (error as { code?: string }).code;
          // Nested reads use the wait's shorter deadline. The outer command is
          // still valid (checked above), so report an unmet wait condition.
          if (code === 'COMMAND_EXPIRED' && Date.now() >= until) break;
          if (code === 'STALE_ELEMENT' && ['detached', 'hidden'].includes(command.condition))
            return { matched: true };
          if (
            !['STALE_ELEMENT', 'PAGE_CHANGED', 'PAGE_LOADING', 'FRAME_UNAVAILABLE'].includes(
              code || '',
            )
          )
            throw error;
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(1, until - Date.now()))),
      );
    }
    checkSession();
    fail(
      'WAIT_TIMEOUT',
      `Condition ${command.condition} did not match within ${command.timeoutMs}ms`,
    );
  }
  if (command.op === 'back' || command.op === 'forward' || command.op === 'reload') {
    await markTask(session, 'ready');
    checkSession();
    parked = false;
    await syncTarget();
    checkSession();
    const tab = await chrome.tabs.get(session.tabId);
    checkSession();
    if (!inScope(tab, session) || !inspectable(tab)) fail('TASK_TAB_UNAVAILABLE');
    if (command.op === 'reload') await chrome.tabs.reload(tab.id!);
    else {
      const history = (await diagnosticSend({ tabId: tab.id! }, 'Page.getNavigationHistory')) as {
        currentIndex: number;
        entries: { id: number; url: string }[];
      };
      checkSession();
      const entry = history.entries[history.currentIndex + (command.op === 'back' ? -1 : 1)];
      if (!entry) fail('NO_HISTORY_ENTRY');
      if (!allowed(entry.url) || isBlockedUrl(entry.url)) fail('BLOCKED_URL');
      await diagnosticSend({ tabId: tab.id! }, 'Page.navigateToHistoryEntry', {
        entryId: entry.id,
      });
    }
    checkSession();
    invalidate();
    return { tabId: tab.id, navigating: true };
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
        await groupOwnedTab(session, target.id);
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
        fail('TAB_NOT_GRANTED', '只能操作当前任务的 Agent 工作标签');
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
    await markTask(session, 'ready');
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
  await chrome.action.setBadgeText({ text: translate(workerLocale(), 'browserBadge') });
  await markTask(session, 'ready');
  checkSession();
  const lease = grant;
  const startGeneration = generation;
  let inputAcknowledged = false;
  const check = () => {
    checkSession();
    if (Date.now() > deadline) fail('COMMAND_EXPIRED');
    if (grant !== lease) stopped('grant_changed');
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
    const result = await actionCdp(method, params);
    check();
    return result as CdpResults[M];
  }
  async function actionCdp(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<any> {
    check();
    const tab = await chrome.tabs.get(lease.id);
    check();
    if (!inScope(tab, session) || !inspectable(tab) || tab.url !== lease.url) fail('PAGE_CHANGED');
    if (isBlockedUrl(tab.url)) fail('BLOCKED_URL');
    if (sessionId && frameSessions().get(sessionId)?.tabId !== lease.id) fail('FRAME_UNAVAILABLE');
    if (dialog) fail('DIALOG_OPEN', `${dialog.type}: ${dialog.message}; use dialog`);
    const target = { tabId: lease.id, ...(sessionId ? { sessionId } : {}) };
    const result = await boundedCdp(async () => {
      const value = await diagnosticSend(target, method, params);
      if (
        (command.op === 'click' &&
          method === 'Input.dispatchMouseEvent' &&
          params.type === 'mouseReleased') ||
        (command.op === 'keypress' &&
          command.key === 'Enter' &&
          method === 'Input.dispatchKeyEvent' &&
          params.type === 'keyDown' &&
          params.key === 'Enter')
      )
        inputAcknowledged = true;
      return value;
    }, check);
    check();
    return result;
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
  const actions = new PageActions({
    send: actionCdp,
    mouse: (params) => cdp('Input.dispatchMouseEvent', params),
    check,
    preview,
    refs,
    generation: startGeneration,
    dragData: () => dragData,
  });
  let readiness:
    Awaited<ReturnType<typeof waitForStablePage>> | { status: string; note: string } | undefined;
  if (['snapshot', 'observe', 'find', 'inspect', 'wait-for-page'].includes(command.op)) {
    const target =
      command.op === 'wait-for-page' && (command.ref || command.x !== undefined)
        ? command
        : pendingScroll;
    try {
      readiness = await waitForStablePage({
        probe: () => actions.readiness(target),
        network: (frames) => networkActivity.sample(frames),
        check,
        timeoutMs: command.op === 'wait-for-page' ? command.timeoutMs : 4000,
        minWaitMs: command.op === 'wait-for-page' ? 1000 : 350,
        boundaryGrace: !!pendingScroll,
      });
    } catch (error) {
      check();
      const code = (error as { code?: string }).code;
      if (
        ['STOPPED', 'PAGE_CHANGED', 'COMMAND_EXPIRED', 'BLOCKED_URL', 'SENSITIVE_INPUT'].includes(
          code || '',
        )
      )
        throw error;
      readiness = {
        status: 'unavailable',
        note: 'Could not establish content stability; inspect the returned evidence or use wait-for-page. No input was replayed.',
      };
    }
    pendingScroll = undefined;
  }
  async function snapshot(interactiveOnly: boolean, viewportOnly = true) {
    return actions.snapshot(
      interactiveOnly,
      [
        `URL: ${lease.url}`,
        `Title: ${lease.title}`,
        `Tab: ${lease.id}`,
        'Scope: selected Agent work tab and its permitted frames. Coordinates use the top viewport in CSS pixels.',
      ],
      viewportOnly,
    );
  }
  async function screenshot() {
    try {
      if (cursor) await showCursor('hide');
      const result = await cdp('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      // Leave room for AX text and the JSON envelope under the bridge's 8 MiB limit.
      if (result.data.length > 7_000_000)
        fail('SCREENSHOT_TOO_LARGE', '截图过大，请缩小浏览器窗口后重新观察');
      // Also validate the active target after capture; never return a different tab's pixels.
      const layout = await cdp('Page.getLayoutMetrics');
      return { ...result, layout };
    } finally {
      if (cursor && control === session && grant === lease)
        await showCursor('restore').catch(() => {});
    }
  }
  if (command.op === 'snapshot' || command.op === 'wait-for-page') {
    const result = await snapshot(
      command.op === 'snapshot' ? command.interactive : false,
      command.op === 'snapshot' ? command.viewport : true,
    );
    if (command.op === 'snapshot' && !command.viewport) return { ...result, readiness };
    const { cssLayoutViewport: v, cssContentSize: content } = await cdp('Page.getLayoutMetrics');
    return {
      ...result,
      readiness,
      tabId: lease.id,
      url: lease.url,
      title: lease.title,
      pageVersion: browserPageVersion(),
      viewport: {
        width: v.clientWidth,
        height: v.clientHeight,
        scrollX: v.pageX,
        scrollY: v.pageY,
        contentHeight: content.height,
        remainingBelow: Math.max(0, content.height - v.pageY - v.clientHeight),
      },
    };
  }
  if (command.op === 'screenshot')
    return screenshotAttachment((await boundedCdp(screenshot, check)).data);
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
      const page = await snapshot(command.interactive);
      const { data, layout } = await boundedCdp(screenshot, check);
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
        viewport: {
          ...viewport,
          scrollX: layout.cssLayoutViewport.pageX,
          scrollY: layout.cssLayoutViewport.pageY,
          contentHeight: layout.cssContentSize.height,
          remainingBelow: Math.max(
            0,
            layout.cssContentSize.height -
              layout.cssLayoutViewport.pageY -
              layout.cssLayoutViewport.clientHeight,
          ),
        },
        ...page,
        readiness,
        screenshot: screenshotAttachment(data),
      };
    } catch (error) {
      // An incomplete observation must not leave a usable new ref set behind.
      refs.clear();
      throw error;
    }
  }
  dragData = null;

  try {
    const result = await actions.run(command);
    if (command.op === 'scroll') pendingScroll = { ref: command.ref, x: command.x, y: command.y };
    else if (!['find', 'inspect', 'frames'].includes(command.op)) pendingScroll = undefined;
    return readiness ? { ...result, readiness } : result;
  } catch (error) {
    // Click/Enter may navigate before CDP's post-dispatch check runs.
    // Report acknowledged input, without replaying it on the new page.
    // Changes before mouseReleased, unacknowledged input and revoked control
    // retain their original errors.
    if (!inputAcknowledged || (error as { code?: string }).code !== 'PAGE_CHANGED') throw error;
    checkSession();
    const tab = await chrome.tabs.get(lease.id);
    checkSession();
    if (
      grant !== lease ||
      !inScope(tab, session) ||
      tab.id !== session.tabId ||
      !inspectable(tab) ||
      isBlockedUrl(tab.url)
    )
      throw error;
    return { done: true, navigating: true, needsObservation: true, tabId: tab.id, url: tab.url };
  }
}

function boundedCdp<T>(work: () => Promise<T>, check: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        check();
        if (dialog) fail('DIALOG_OPEN', `${dialog.type}: ${dialog.message}; use dialog`);
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, 50);
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          clearInterval(timer);
          resolve(value);
        },
        (error) => {
          clearInterval(timer);
          reject(error);
        },
      );
  });
}
