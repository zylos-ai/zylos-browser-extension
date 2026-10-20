import { serializeDetail, type DetailEvent } from '../detailed-diagnostics';
import { startFrameDiagnostics } from './iframe-diagnostics';

type Context = { task?: number; operation?: number };
type Lease = { token: string; context: Context; generation?: number };
type TargetState = {
  tabId?: number;
  granted: boolean;
  controlled: boolean;
  borrowed: boolean;
  revision?: number;
  groupReference?: 'none' | 'assigned';
};
let hooks:
  | {
      capture: () => Lease | undefined;
      valid: (lease: Lease) => boolean;
      emit: (lease: Lease, event: DetailEvent) => void;
      secrets: () => string[];
      incident?: (context: Context, reason?: string) => void;
    }
  | undefined;
let state: () => TargetState = () => ({ granted: false, controlled: false, borrowed: false });
let epoch = '';
let sequence = 0;
let ids = new Map<string, number>();
let reporting = false;
let probeKey = '';
let stopProbe: (() => void) | undefined;
let refreshing = false;
let targetTypes = new Map<number, { type: string; observedAt: number }>();
let ackSummary:
  { key: string; startedAt: number; lastReportedAt: number; successful: number } | undefined;

export function configureCdpDiagnostics(value: typeof hooks) {
  hooks = value;
}
export function setDiagnosticTarget(provider: typeof state) {
  state = provider;
}
export function refreshCdpDiagnostics() {
  if (refreshing) return;
  refreshing = true;
  try {
    const lease = capture();
    const target = state();
    const key =
      lease && target.granted && target.controlled && target.tabId !== undefined
        ? `${lease.token}:${lease.context.task}:${target.tabId}:${target.revision}`
        : '';
    if (key === probeKey) return;
    const previous = stopProbe;
    stopProbe = undefined;
    probeKey = key;
    previous?.();
    if (key && lease && target.tabId !== undefined) {
      const probe = ++sequence;
      stopProbe = startFrameDiagnostics(
        target.tabId,
        () => probeKey === key && !!hooks?.valid(lease),
        (event) => emit(lease, { probe, ...event }),
        () =>
          !!hooks?.valid(lease) &&
          state().revision === target.revision &&
          (state().tabId === undefined || state().tabId === target.tabId),
      );
    }
  } catch {
    /* A denied or unavailable probe does not change control. */
  } finally {
    refreshing = false;
  }
}
function capture() {
  try {
    const lease = hooks?.capture();
    if (!lease) {
      epoch = '';
      ids.clear();
      targetTypes.clear();
      ackSummary = undefined;
      return;
    }
    if (lease.token !== epoch) {
      epoch = lease.token;
      ids = new Map();
      sequence = 0;
      targetTypes.clear();
      ackSummary = undefined;
    }
    return lease;
  } catch {
    return;
  }
}
function opaque(kind: string, value?: string | number) {
  if (value === undefined) return undefined;
  const key = `${kind}:${value}`;
  if (!ids.has(key) && ids.size < 512) ids.set(key, ids.size + 1);
  return ids.get(key);
}
function targetInfo(target: chrome.debugger.Debuggee & { sessionId?: string }) {
  return { tab: opaque('tab', target.tabId), session: opaque('session', target.sessionId) };
}
function currentState() {
  try {
    const value = state();
    return {
      tab: opaque('tab', value.tabId),
      granted: value.granted,
      controlled: value.controlled,
      borrowed: value.borrowed,
      groupReference: value.groupReference,
    };
  } catch {
    return undefined;
  }
}
export function recordControlDiagnostic(reason: string) {
  try {
    const lease = capture();
    if (lease)
      emit(lease, {
        event: 'release',
        reason: /^[a-z_]{1,40}$/.test(reason) ? reason : 'other',
        state: currentState(),
      });
  } catch {
    /* Diagnostics do not affect release. */
  }
}
export function recordGroupDiagnostic(reason: 'presentation-failed' | 'removed') {
  try {
    const lease = capture();
    if (lease) emit(lease, { event: 'task-group', reason, state: currentState() });
  } catch {
    /* Cosmetic group state must not affect browser actions. */
  }
}
function emit(lease: Lease | undefined, metadata: object, error?: unknown) {
  if (!lease || reporting) return;
  reporting = true;
  try {
    if (!hooks?.valid(lease)) return;
    const detail = error === undefined ? undefined : serializeDetail([error], hooks.secrets());
    const receivedAt = Date.now();
    const frame = metadata as { event?: string; observedAt?: number };
    const observedAt =
      frame.event?.startsWith('iframe-') && Number.isFinite(frame.observedAt)
        ? frame.observedAt
        : undefined;
    hooks.emit(lease, {
      kind: error === undefined ? 'console' : 'error',
      level: error === undefined ? 'debug' : 'error',
      at: observedAt ?? receivedAt,
      text: `CDP ${JSON.stringify(observedAt === undefined ? metadata : { ...metadata, receivedAt })}${detail ? `\n${detail.text}` : ''}`,
      truncated: detail?.truncated ?? false,
    });
  } catch {
    /* Diagnostic failures must never affect browser operations. */
  } finally {
    reporting = false;
  }
}

export function recordDebuggerEvent(
  event: 'detach' | 'frame-attach' | 'frame-detach',
  target: chrome.debugger.Debuggee & { sessionId?: string },
  reason?: string,
) {
  try {
    const lease = capture();
    if (!lease) return;
    const before = state();
    if (!before.controlled || target.tabId !== before.tabId) return;
    if (event === 'detach') hooks?.incident?.(lease.context, reason);
    const knownType = target.tabId === undefined ? undefined : targetTypes.get(target.tabId);
    emit(lease, {
      event,
      ...targetInfo(target),
      reason: ['target_closed', 'canceled_by_user'].includes(reason || '') ? reason : undefined,
      state: currentState(),
      ...(event === 'detach'
        ? {
            eventSource: 'chrome.debugger.onDetach',
            targetScope: 'parent-debuggee',
            targetType: knownType?.type ?? 'unknown',
            targetTypeSource: knownType ? 'earlier-getTargets' : 'unavailable',
            targetTypeObservedAt: knownType?.observedAt,
          }
        : {}),
    });
    if (event === 'detach') inspectTarget(lease, target, 'detach-target-state');
  } catch {
    /* Event listeners must not be affected by unavailable diagnostics. */
  }
}
function inspectTarget(lease: Lease, target: chrome.debugger.Debuggee, event: string) {
  try {
    const before = state();
    if (target.tabId !== undefined) {
      const tabId = target.tabId;
      let timeout: ReturnType<typeof setTimeout>;
      const pending = Promise.allSettled([chrome.tabs.get(tabId), chrome.debugger.getTargets()]);
      void Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), 1000);
        }),
      ])
        .then((results) => {
          clearTimeout(timeout);
          if (
            state().revision !== before.revision ||
            (state().tabId !== undefined && state().tabId !== tabId)
          )
            return;
          if (!results) {
            emit(lease, { event, ...targetInfo(target), status: 'unavailable', reason: 'timeout' });
            return;
          }
          const [tab, targets] = results;
          const targetPresent =
            targets.status === 'fulfilled'
              ? targets.value.find((value) => value.tabId === tabId)
              : undefined;
          const observedAt = Date.now();
          const targetType = targetPresent
            ? [
                'page',
                'background_page',
                'worker',
                'iframe',
                'service_worker',
                'shared_worker',
                'other',
              ].includes(targetPresent.type)
              ? targetPresent.type
              : 'other'
            : 'unknown';
          if (targetPresent && hooks?.valid(lease)) {
            if (targetTypes.size >= 32) targetTypes.delete(targetTypes.keys().next().value!);
            targetTypes.set(tabId, { type: targetType, observedAt });
          }
          emit(lease, {
            event,
            ...targetInfo(target),
            tabState: tab.status === 'fulfilled' ? 'present' : 'unavailable',
            discarded: tab.status === 'fulfilled' ? tab.value.discarded === true : undefined,
            debuggerTarget:
              targets.status === 'fulfilled'
                ? targetPresent
                  ? 'present'
                  : 'absent'
                : 'unavailable',
            attached: targetPresent?.attached,
            target: opaque('target', targetPresent?.id),
            targetType,
            targetTypeSource: 'getTargets-query',
            targetTypeObservedAt: observedAt,
          });
        })
        .catch(() => {});
    }
  } catch {
    /* A failed state probe never changes debugger control. */
  }
}

async function trace<T>(
  method: string,
  target: chrome.debugger.Debuggee & { sessionId?: string },
  work: () => Promise<T>,
): Promise<T> {
  const lease = capture();
  if (!lease) return work();
  const id = ++sequence;
  const started = Date.now();
  const metadata = {
    call: id,
    method: /^[A-Za-z]+\.[A-Za-z]+$/.test(method) ? method : 'other',
    ...targetInfo(target),
  };
  const ack = method === 'Page.screencastFrameAck';
  if (!ack) emit(lease, { ...metadata, phase: 'start', state: currentState() });
  try {
    const result = await work();
    const durationMs = Math.max(0, Date.now() - started);
    if (!ack || durationMs >= 250)
      emit(lease, {
        ...metadata,
        phase: ack ? 'slow-success' : 'success',
        durationMs,
        state: currentState(),
      });
    if (ack) {
      try {
        if (hooks?.valid(lease)) {
          const key = `${lease.token}:${lease.generation}:${lease.context.task}`;
          const now = Date.now();
          if (ackSummary?.key !== key)
            ackSummary = { key, startedAt: started, lastReportedAt: -Infinity, successful: 0 };
          ackSummary.successful++;
          if (now - ackSummary.lastReportedAt >= 5000) {
            ackSummary.lastReportedAt = now;
            emit(lease, {
              event: 'screencast-ack-summary',
              successful: ackSummary.successful,
              from: ackSummary.startedAt,
              through: now,
              partial: true,
            });
          }
        }
      } catch {
        /* Aggregation must not affect preview acknowledgements. */
      }
    }
    if (method === 'Debugger.attach') inspectTarget(lease, target, 'attach-target-state');
    return result;
  } catch (error) {
    emit(
      lease,
      {
        ...metadata,
        phase: 'error',
        durationMs: Math.max(0, Date.now() - started),
        state: currentState(),
      },
      error,
    );
    throw error;
  }
}
export function diagnosticSend(
  target: chrome.debugger.Debuggee & { sessionId?: string },
  method: string,
  params?: Record<string, unknown>,
): Promise<any> {
  return trace(method, target, () => chrome.debugger.sendCommand(target, method, params));
}
export function diagnosticAttach(target: chrome.debugger.Debuggee, version: string) {
  return trace('Debugger.attach', target, () => chrome.debugger.attach(target, version));
}
export function diagnosticDetach(target: chrome.debugger.Debuggee) {
  return trace('Debugger.detach', target, () => chrome.debugger.detach(target));
}
