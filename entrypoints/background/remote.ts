import {
  LANGUAGE_STORAGE_KEY,
  setWorkerLanguage,
  panelErrorMessage,
  workerLocale,
} from '../../utils/i18n';
import { formatTaskNotice, type TaskNotice } from '../../utils/task-notice';
import { CONTROL_RECOVERY_CAPABILITY } from '../../utils/control-loss';
import {
  DIAGNOSTICS_CAPABILITY,
  detailedContext,
  currentDetailedTaskGeneration,
  diagnosticsEnabled,
  diagnosticsConsent,
  diagnosticsEpoch,
  acceptPanelDiagnostic,
  recordLifecycle,
  startDiagnosticTask,
  endDiagnosticTask,
  startDiagnosticOperation,
  endDiagnosticOperation,
  diagnosticRequest,
  diagnosticStorage,
  expireDiagnostics,
  getDiagnostics,
  initializeDiagnostics,
  recordDiagnostic,
  setDiagnosticsEnabled,
} from '../../utils/diagnostics';
import { installRuntimeDiagnostics } from '../../utils/diagnostics-runtime';
import { DetailedCapture, serializeDetail } from '../../utils/detailed-diagnostics';
import { DetailedSharing } from '../../utils/detailed-sharing';
import { installDetailedRuntime } from '../../utils/detailed-runtime';
import { IncidentCapture } from '../../utils/incident-bundle';
import {
  configureCdpDiagnostics,
  refreshCdpDiagnostics,
} from '../../utils/automation/cdp-diagnostics';
import { safeError } from '../../utils/diagnostics-schema';
// Extension-owned conversations: request Agent decisions, execute locally, and
// return observations over the authenticated Remote connection.
import { captureCurrentPage, clearPageContexts, forgetPageContext } from '../../utils/page-context';
import {
  completeTask,
  abortControlRecovery,
  configureControlRecovery,
  currentControl,
  currentGrant,
  diagnosticNavigationRevision,
  initializeExecutor,
  onState,
  release,
  revealTask,
} from '../../utils/automation/executor';
import { recoverTasks } from '../../utils/automation/task-lifecycle';
import { isPanelSender } from '../../utils/messages';
import {
  CHAT_LOG_CAP,
  BROWSER_ID_RE,
  INSTANCE_CAPABILITY,
  INTERRUPT_CAPABILITY,
  RESUME_CAPABILITY,
  RECOVERY_WINDOW_MS,
  REMOTE_BROWSER_ID_KEY,
  REMOTE_CHAT_LOG_KEY,
  REMOTE_CONFIG_KEY,
  REMOTE_KEY_PROTO_PREFIX,
  REMOTE_SUBPROTOCOL,
  REMOTE_VERSION,
  chatEntrySchema,
  initialRemoteState,
  keyIdOf,
  relayFrameSchema,
  relayHostOf,
  remoteConfigSchema,
  remoteRequestSchema,
  type ChatEntry,
  type RemoteConfig,
  type RemoteState,
} from '../../utils/remote';
import { IdempotencyCache, REMOTE_CAPABILITIES, dispatch } from '../../utils/browser-actions';
import { z } from 'zod';
import { ToolActivity } from '../../utils/tool-activity';
import { LivePreview } from '../../utils/automation/live-preview';
import { BrowserLoop } from '../../utils/browser-loop';
import { runBrowserRound } from '../../utils/browser-round';
import {
  AGENT_MESSAGE_CAPABILITY,
  STEER_CAPABILITY,
  messageText,
  messageAttachments,
} from '../../utils/agent-message';
import {
  ATTACHMENT_CAPABILITY,
  attachmentSelection,
  storedAttachments,
  pruneImagePreviews,
} from '../../utils/attachments';

import {
  AGENT_ACTIVITY_CAPABILITY,
  AGENT_HISTORY_CAPABILITY,
  appendAgentEvents,
  pruneAgentHistory,
} from '../../utils/agent-activity';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const KEEPALIVE_ALARM = 'remote-keepalive';
const HANDSHAKE_TIMEOUT_MS = 10000;

export function startRemoteBackground() {
  installRuntimeDiagnostics(({ event, ...metadata }) =>
    recordLifecycle(event, { ...metadata, source: 'background' }),
  );
  initializeExecutor();
  const preview = new LivePreview();
  const state: RemoteState = { ...initialRemoteState, chat: [] };
  let config: RemoteConfig = remoteConfigSchema.parse({});
  let socket: WebSocket | null = null;
  let generation = 0; // bumps on every (re)connect so stale socket handlers go inert
  let backoff = BACKOFF_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const idem = new IdempotencyCache();
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let loopReady = false;
  let controlRecoveryReady = false;
  let attachmentsReady = false;
  let interruptReady = false;
  let sendingChat = false;
  let panelMutations: Promise<unknown> = Promise.resolve();
  let stopTaskPromise: Promise<void> | undefined;
  let pendingStop: { taskId: string; resolve: (ok: boolean) => void } | undefined;
  let chatRevision = 0;
  let loop: BrowserLoop;
  let incidents: IncidentCapture | undefined;
  const sharing = new DetailedSharing(() => publish());
  const detailed = new DetailedCapture(
    () => {
      sharing.revoke();
      incidents?.clear();
      refreshCdpDiagnostics();
      publish();
    },
    () => [config.key],
  );
  const shareContext = () => ({
    ...detailed.state(),
    generation,
    recipient: config.relayUrl,
    connected: state.connected && loopReady && socket?.readyState === WebSocket.OPEN,
  });
  const incidentRuntime = () => {
    const control = currentControl();
    return {
      connected: state.connected,
      control: !!control,
      granted: !!currentGrant(),
      scope: !control
        ? ('none' as const)
        : control.borrowedTabId === control.tabId
          ? ('borrowed' as const)
          : ('owned' as const),
      groupReference:
        control && control.groupId !== null ? ('assigned' as const) : ('none' as const),
    };
  };
  incidents = new IncidentCapture(() => {
    const consent = detailed.state().consent;
    return consent
      ? {
          consent,
          generation: currentDetailedTaskGeneration(),
          navigation: diagnosticNavigationRevision(),
          tabId: currentControl()?.tabId,
        }
      : { consent: '', generation: 0, navigation: 0 };
  }, incidentRuntime);
  const incidentPreview = (consent: string) =>
    incidents!.bundle(detailed.preview(consent), incidentRuntime());
  configureCdpDiagnostics({
    capture: () => {
      const token = detailed.state().consent;
      return token
        ? { token, context: detailedContext(), generation: currentDetailedTaskGeneration() }
        : undefined;
    },
    valid: (lease) =>
      detailed.valid(lease.token) && lease.generation === currentDetailedTaskGeneration(),
    emit: (lease, event) => {
      detailed.append(lease.token, 'background', event, lease.context);
    },
    secrets: () => [config.key],
    incident: (context, reason) => {
      incidents?.trigger(context, 'debugger-detach', reason);
    },
  });
  installDetailedRuntime(
    (event) => detailed.append(detailed.state().consent, 'background', event, detailedContext()),
    () => detailed.state().enabled,
    () => [config.key],
  );
  const runtimeEpoch = crypto.randomUUID();
  let resumeReady = false;
  let recoveryWindowMs = RECOVERY_WINDOW_MS;
  let recoveryDeadline = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryNoticeRevision = 0;
  function setRecovery(value: RemoteState['recovery']) {
    clearTimeout(recoveryNoticeTimer);
    const revision = ++recoveryNoticeRevision;
    state.recovery = value;
    if (value === 'restored')
      recoveryNoticeTimer = setTimeout(() => {
        if (revision !== recoveryNoticeRevision || state.recovery !== 'restored') return;
        state.recovery = undefined;
        publish();
      }, 3000);
  }
  let reconnectBlocked = false;
  let freshRecoveryAttempted = false;
  const transportWaiters = new Set<() => void>();
  const outbox = new Map<string, Record<string, unknown>>();
  let helloResume:
    | {
        taskId: string;
        requestId?: string;
        round?: number;
        phase: 'waiting' | 'executing' | 'terminal';
      }
    | undefined;

  function wakeTransport() {
    for (const wake of transportWaiters) wake();
    transportWaiters.clear();
  }
  async function waitForTransport(assertActive: () => void) {
    assertActive();
    while (!state.connected) {
      if (!recoveryDeadline || Date.now() >= recoveryDeadline)
        throw Object.assign(new Error('Task transport unavailable'), { code: 'STOPPED' });
      await new Promise<void>((resolve) => transportWaiters.add(resolve));
      assertActive();
    }
  }
  function resumeDescriptor() {
    const terminal = [...outbox.values()].find((frame) => frame.type === 'agent-turn-end');
    const taskId = loop?.taskId ?? (terminal?.taskId as string | undefined);
    if (!taskId) return undefined;
    return {
      taskId,
      ...(loop?.currentRequestId ? { requestId: loop.currentRequestId, round: loop.round } : {}),
      phase: !loop?.active
        ? ('terminal' as const)
        : loop.pendingId
          ? ('waiting' as const)
          : ('executing' as const),
    };
  }
  function completionPending() {
    return !loop?.active && [...outbox.values()].some((frame) => frame.type === 'agent-turn-end');
  }
  function failRecovery(error = 'ui.error.taskRecoveryFailed') {
    const taskId = resumeDescriptor()?.taskId;
    clearTimeout(recoveryTimer);
    recoveryDeadline = 0;
    setRecovery('failed');
    state.error = error;
    if (loop.active) cancelLoop('interrupted');
    outbox.clear();
    wakeTransport();
    preview.finish('interrupted');
    activity.end('interrupted');
    void completeTask().catch(() => {});
    if (taskId) {
      const notice: TaskNotice = {
        kind: 'request-failed',
        code: error.endsWith('Expired') ? 'TASK_RECOVERY_EXPIRED' : 'TASK_RECOVERY_FAILED',
      };
      void appendChat({
        id: `recovery:${taskId}`,
        role: 'assistant',
        text: formatTaskNotice(workerLocale(), notice),
        notice,
        final: true,
        ts: Date.now(),
      }).catch(() => {});
    }
    publish();
  }

  const publish = () => {
    preview.sync(currentControl(), currentGrant(), state.connected);
    void chrome.runtime.sendMessage({ type: 'remote-updated', state: snapshot() }).catch(() => {});
  };
  function snapshot(): RemoteState {
    state.detailedDiagnostics = detailed.state();
    state.detailedSharing = sharing.state();
    state.diagnosticsEnabled = diagnosticsEnabled();
    state.diagnosticsConsent = diagnosticsConsent();
    if (!loop?.active || state.agentActivity?.taskId !== loop.taskId)
      state.agentActivity = undefined;
    state.loopActive = loop?.active ?? false;
    state.stopping = !!stopTaskPromise;
    state.completionPending = completionPending();
    state.chatBusy = sendingChat || state.loopActive || state.stopping || state.completionPending;
    const control = currentControl();
    const grant = currentGrant();
    const previous =
      state.task?.sessionId === control?.sessionId && state.task?.tabId === control?.tabId
        ? state.task
        : null;
    const running = loop?.active;
    state.task = control
      ? {
          sessionId: control.sessionId,
          phase: control.phase === 'ready' && running ? 'running' : control.phase,
          tabId: control.tabId,
          tabCount: control.tabIds.length,
          url: grant?.url ?? previous?.url ?? '',
          title: grant?.title ?? previous?.title ?? '',
        }
      : null;
    state.configured = !!(config.relayUrl && config.key);
    state.enabled = config.enabled;
    state.relayHost = relayHostOf(config.relayUrl);
    state.relayUrl = config.relayUrl;
    return state;
  }
  let hadControl = false;
  onState(() => {
    const hasControl = !!currentControl();
    // Closing the task tab / Chrome's debugger Cancel while awaiting the model
    // must also cancel that pending decision, not allow a later open to revive it.
    if (
      hadControl &&
      !hasControl &&
      !loop.recovering &&
      (loop?.pendingId || (recoveryDeadline && loop?.active && !loop.settling))
    ) {
      cancelLoop('interrupted');
      preview.finish('interrupted');
      activity.end('interrupted');
    }
    hadControl = hasControl;
    publish();
  });

  // ---------------------------------------------------------------- chat log
  let saveQueue: Promise<unknown> = Promise.resolve();
  let activitySaveTimer: ReturnType<typeof setTimeout> | undefined;
  function persistChat() {
    clearTimeout(activitySaveTimer);
    // Serialize writes and capture the current log when the write starts, so a
    // delayed tool update can never restore history that the user has cleared.
    const saving = saveQueue
      .catch(() => {})
      .then(() => {
        pruneImagePreviews(state.chat);
        pruneAgentHistory(state.chat);
        return diagnosticStorage('write', () =>
          chrome.storage.local.set({ [REMOTE_CHAT_LOG_KEY]: structuredClone(state.chat) }),
        );
      });
    saveQueue = saving;
    return saving;
  }
  const activityChanged = () => {
    publish();
    clearTimeout(activitySaveTimer);
    activitySaveTimer = setTimeout(() => {
      void persistChat().catch(() => {
        state.error = 'ui.error.chatSaveFailed';
        publish();
      });
    }, 250);
  };
  const activity = new ToolActivity(
    () => state.chat,
    activityChanged,
    () => {
      const control = currentControl();
      const grant = currentGrant();
      return control && grant?.id === control.tabId
        ? JSON.stringify([control.sessionId, control.tabId, grant.url])
        : undefined;
    },
  );
  async function appendChat(entry: ChatEntry) {
    const existing =
      entry.id && state.chat.findIndex((m) => m.role === entry.role && m.id === entry.id);
    if (typeof existing === 'number' && existing >= 0) state.chat[existing] = entry;
    else state.chat.push(entry);
    if (state.chat.length > CHAT_LOG_CAP) state.chat.splice(0, state.chat.length - CHAT_LOG_CAP);
    await persistChat();
    publish();
  }

  async function updateDelivery(m: {
    state: string;
    chatId?: string;
    code?: string;
    error?: string;
  }) {
    const entry =
      m.chatId && state.chat.find((item) => item.role === 'user' && item.id === m.chatId);
    if (!entry) {
      if (!m.chatId && m.error) {
        state.error = m.error;
        publish();
      }
      return;
    }
    if (!['queued', 'failed', 'unknown'].includes(m.state)) return;
    entry.delivery = m.state as 'queued' | 'failed' | 'unknown';
    entry.deliveryError =
      m.state === 'queued'
        ? undefined
        : m.code === 'AGENT_UNAVAILABLE'
          ? 'ui.error.agentUnavailable'
          : m.state === 'unknown'
            ? 'ui.error.deliveryUnconfirmed'
            : 'ui.error.chatDeliveryFailed';
    await persistChat();
    publish();
  }

  // ---------------------------------------------------------------- socket
  const sendRaw = (frame: Record<string, unknown>) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  };
  const send = (frame: Record<string, unknown>) => {
    const retained =
      resumeReady &&
      ['agent-request', 'agent-input', 'agent-turn-end'].includes(String(frame.type));
    if (!retained) return sendRaw(frame);
    // Acknowledgement, not WebSocket.send(), transfers ownership to Remote.
    if (outbox.size >= 64) {
      queueMicrotask(() => failRecovery('ui.error.taskRecoveryFailed'));
      return false;
    }
    const deliveryId = crypto.randomUUID();
    const envelope = { ...frame, deliveryId, runtimeEpoch };
    outbox.set(deliveryId, envelope);
    if (state.connected && !sendRaw(envelope)) socket?.close();
    return true;
  };

  loop = new BrowserLoop({
    updates: (ids, status) => {
      if (!ids.length) return;
      const latest = state.chat.find((entry) => entry.id === ids[0]);
      for (const entry of state.chat)
        if (
          entry.steerStatus &&
          entry.taskId === loop.taskId &&
          (status === 'interrupted'
            ? entry.steerStatus !== 'applied'
            : latest && entry.ts <= latest.ts)
        )
          entry.steerStatus = status;
      void persistChat().catch(() => {
        state.error = 'ui.error.chatSaveFailed';
      });
      publish();
    },
    progress: (summary) => {
      activity.describe(summary);
      if (!summary) return;
      const history = state.chat.find((entry) => entry.id === loop.taskId)?.agentHistory;
      if (!history || history.status !== 'running') return;
      const lastCommentary = history.events.findLast((event) => event.kind === 'commentary');
      if (lastCommentary?.kind === 'commentary' && lastCommentary.text.trim() === summary.trim())
        return;
      // The Agent's public decision summary is already correlated to this task.
      // Persist it directly; it must survive missing logs and Agent session rotation.
      appendAgentEvents(history, [
        {
          id: `decision-progress:${crypto.randomUUID()}`,
          kind: 'commentary',
          at: Date.now(),
          text: summary,
        },
      ]);
      pruneAgentHistory(state.chat);
      activityChanged();
    },
    send: (request) => send({ type: 'agent-request', ...request }),
    input: (input) => send({ type: 'agent-input', ...input }),
    record: (method, result) => {
      const taskId = loop.taskId;
      const id = crypto.randomUUID();
      const step = activity.begin(method, {});
      step?.start();
      send({ type: 'agent-event', phase: 'start', taskId, id, method, params: {} });
      step?.finish();
      send({
        type: 'agent-event',
        phase: 'end',
        taskId,
        id,
        method,
        result: {
          completed: true,
          outputBytes: new TextEncoder().encode(JSON.stringify(result)).length,
        },
      });
    },
    cancel: () => idem.cancel(),
    revokeRecovery: () => abortControlRecovery(),
    error: () => {
      endDiagnosticTask('interrupted', true);
      state.error = 'ui.error.chatSaveFailed';
      if (loop.taskId) send({ type: 'agent-turn-end', taskId: loop.taskId, status: 'interrupted' });
      setTimeout(publish, 0);
    },
    execute: (actions, assertActive, requestId, hasUpdates, expectedControl) =>
      runBrowserRound(
        actions,
        async (method, params, id) => {
          await waitForTransport(assertActive);
          assertActive();
          const diagnosticOperation = startDiagnosticOperation(method);
          const taskId = loop.taskId;
          const incidentOperation = incidents?.begin(detailedContext(), taskId, id, method);
          const operationConsent = detailed.state().consent;
          const operationGeneration = currentDetailedTaskGeneration();
          const step = activity.begin(method, params);
          step?.start();
          send({ type: 'agent-event', phase: 'start', taskId, id, method, params });
          try {
            const result = await dispatch(
              { method, params, requestId: id, keyId: state.keyId },
              idem,
              undefined,
              () => {
                preview.resume(method);
                publish();
              },
            );
            assertActive();
            incidents?.end(incidentOperation, 'completed');
            endDiagnosticOperation(diagnosticOperation);
            step?.finish();
            preview.result(method, false, activity.hasUnresolvedErrors());
            // Diagnostics carry bounded metadata, never screenshot Base64/page bodies.
            send({
              type: 'agent-event',
              phase: 'end',
              taskId,
              id,
              method,
              result: {
                completed: true,
                outputBytes: new TextEncoder().encode(JSON.stringify(result)).length,
              },
            });
            return result;
          } catch (error) {
            incidents?.end(incidentOperation, 'error');
            if (
              operationConsent &&
              detailed.valid(operationConsent) &&
              operationGeneration === currentDetailedTaskGeneration()
            )
              incidents?.trigger(
                { task: diagnosticOperation.task, operation: diagnosticOperation.op },
                'operation-error',
              );
            if (
              detailed.valid(operationConsent) &&
              operationGeneration === currentDetailedTaskGeneration()
            )
              detailed.append(
                operationConsent,
                'background',
                {
                  kind: 'error',
                  level: 'error',
                  at: Date.now(),
                  ...serializeDetail([error], [config.key]),
                },
                { task: diagnosticOperation.task, operation: diagnosticOperation.op },
              );
            endDiagnosticOperation(diagnosticOperation, error, true);
            const e = error as { code?: string; message?: string };
            step?.finish(e.code || 'EXT_ERROR');
            send({
              type: 'agent-event',
              phase: 'end',
              taskId,
              id,
              method,
              error: { code: e.code || 'EXT_ERROR', message: (e.message || '').slice(0, 1000) },
            });
            throw error;
          } finally {
            publish();
          }
        },
        assertActive,
        requestId,
        hasUpdates,
        expectedControl,
        () => waitForTransport(assertActive),
      ),
    finish: async (text, status, taskId, notice, interruption) => {
      if (interruption) incidents?.trigger(detailedContext(), 'control-lost');
      state.agentActivity = undefined;
      idem.cancel();
      preview.finish(status === 'done' ? 'completed' : 'error');
      activity.end(status === 'done' ? 'completed' : 'interrupted');
      const recoveryTerminal = loop.recovering;
      const cleanup = completeTask().catch(() => {
        recordDiagnostic('runtime-error', 'finalize', {
          source: 'background',
          level: 'error',
          code: 'EXT_ERROR',
        });
        if (loop.taskId === taskId) state.error = 'ui.error.taskCleanupFailed';
      });
      if (recoveryTerminal) {
        // Executor revokes immediately and fences late native attachment work.
        // A stuck native call must not withhold the terminal transport receipt.
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            cleanup,
            new Promise<void>((resolve) => {
              cleanupTimer = setTimeout(() => {
                recordDiagnostic('runtime-error', 'finalize', {
                  source: 'background',
                  level: 'warn',
                  code: 'COMMAND_EXPIRED',
                });
                resolve();
              }, 1000);
            }),
          ]);
        } finally {
          clearTimeout(cleanupTimer);
        }
      } else await cleanup;
      if (loop.taskId !== taskId) return;
      const message = state.chat.find((entry) => entry.role === 'user' && entry.id === taskId);
      if (message) {
        message.loopStatus = status;
        if (message.agentHistory) {
          message.agentHistory.status =
            status === 'done' || status === 'blocked' ? 'completed' : 'interrupted';
          message.agentHistory.endedAt = Date.now();
        }
      }
      await appendChat({
        id: crypto.randomUUID(),
        role: 'assistant',
        text,
        ...(notice ? { notice } : {}),
        final: true,
        ts: Date.now(),
      });
      send({
        type: 'agent-turn-end',
        taskId,
        status,
        text,
        ...(interruption ? { interruption } : {}),
      });
      endDiagnosticTask(status);
      // BrowserLoop releases ownership after this durable completion callback.
      setTimeout(publish, 0);
    },
  });

  configureControlRecovery({
    enabled: () => controlRecoveryReady && loop.controlRecoveryAllowed,
    onSuspended: (recovery) => loop.suspendRecovery(recovery),
    onRevoked: (outcome) => loop.endRecovery(outcome),
  });

  function cancelLoop(status: 'stopped' | 'interrupted', interrupt = false) {
    state.agentActivity = undefined;
    chatRevision++; // Also invalidate a message still collecting its initial page overview.
    const taskId = loop.taskId;
    if (taskId) endDiagnosticTask(status, true);
    loop.cancel();
    wakeTransport();
    // Cancelled requests/steering must never be replayed after a local stop.
    for (const [id, frame] of outbox)
      if (frame.taskId === taskId && frame.type !== 'agent-turn-end') outbox.delete(id);
    if (taskId) {
      const message = state.chat.find((entry) => entry.role === 'user' && entry.id === taskId);
      if (message) {
        message.loopStatus = status;
        if (message.agentHistory) {
          message.agentHistory.status = status;
          message.agentHistory.endedAt = Date.now();
        }
      }
      send({ type: 'agent-turn-end', taskId, status, ...(interrupt ? { interrupt: true } : {}) });
      void persistChat().catch(() => {});
    }
  }

  function stopCurrentTask(): Promise<void> {
    if (stopTaskPromise) return stopTaskPromise;
    stopTaskPromise = Promise.resolve()
      .then(async () => {
        const taskId = loop.taskId;
        const canInterrupt = interruptReady;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const confirmation =
          taskId && canInterrupt
            ? new Promise<boolean>((resolve) => {
                pendingStop = { taskId, resolve };
                timer = setTimeout(() => resolve(false), 11000);
              })
            : null;
        cancelLoop('stopped', !!confirmation);
        preview.finish('stopped');
        clearPageContexts();
        idem.cancel();
        activity.end('stopped');
        try {
          // Revoke browser control immediately, independently of the runtime key
          // receipt and storage. Hold the send lock until both operations settle.
          const [cleanup, remote] = await Promise.allSettled([
            release(true, false, 'panel_stop'),
            confirmation ?? Promise.resolve(false),
          ]);
          if (taskId && (remote.status !== 'fulfilled' || !remote.value))
            state.error = canInterrupt
              ? 'ui.error.agentStopUnconfirmed'
              : 'ui.error.agentStopUnsupported';
          if (cleanup.status === 'rejected') throw cleanup.reason;
        } finally {
          clearTimeout(timer);
          pendingStop = undefined;
          await persistChat();
        }
      })
      .finally(() => {
        stopTaskPromise = undefined;
        publish();
      });
    publish();
    return stopTaskPromise;
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (!config.enabled || !state.configured || reconnectBlocked) return;
    const jitter = Math.floor(Math.random() * 500);
    reconnectTimer = setTimeout(() => void connect(), backoff + jitter);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  function disconnect(reason: string) {
    sharing.revoke();
    if (socket) recordDiagnostic('socket-close', 'remote_disconnect', { closeCode: 1000 });
    if (loop.active) {
      cancelLoop('interrupted');
      void completeTask().catch(() => {});
    }
    clearTimeout(recoveryTimer);
    recoveryDeadline = 0;
    resumeReady = false;
    reconnectBlocked = false;
    freshRecoveryAttempted = false;
    outbox.clear();
    wakeTransport();
    setRecovery(undefined);
    loopReady = false;
    controlRecoveryReady = false;
    interruptReady = false;
    clearTimeout(handshakeTimer);
    preview.finish('interrupted');
    clearTimeout(reconnectTimer);
    generation++;
    const old = socket;
    socket = null;
    state.connected = false;
    state.endpointId = '';
    state.connecting = false;
    idem.cancel();
    activity.end('interrupted');
    try {
      old?.close(1000, reason);
    } catch {
      /* already closed */
    }
  }

  async function connect() {
    snapshot();
    if (!config.enabled || !state.configured || reconnectBlocked) return;
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    const gen = ++generation;
    recordLifecycle('transport-connect');
    state.connecting = true;
    if (recoveryDeadline) setRecovery('reconnecting');
    if (state.recovery !== 'failed') state.error = '';
    publish();
    let ws: WebSocket;
    try {
      ws = new WebSocket(config.relayUrl, [
        REMOTE_SUBPROTOCOL,
        `${REMOTE_KEY_PROTO_PREFIX}${config.key}`,
      ]);
    } catch (e) {
      recordLifecycle('transport-error', {
        level: 'error',
        ...safeError(e),
        code: 'INVALID_RELAY',
      });
      state.connecting = false;
      state.error = 'ui.error.invalidRelayUrl';
      publish();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      if (gen !== generation) return;
      recordLifecycle('transport-open');
      backoff = BACKOFF_MIN_MS;
      state.connected = false;
      state.connecting = true;
      if (state.recovery !== 'failed') state.error = '';
      helloResume = recoveryDeadline ? resumeDescriptor() : undefined;
      sendRaw({
        type: 'hello',
        version: REMOTE_VERSION,
        capabilities: [
          'diagnostics-detail-share-v1',
          'diagnostics-incident-bundle-v2',
          CONTROL_RECOVERY_CAPABILITY,
          ...REMOTE_CAPABILITIES,
          DIAGNOSTICS_CAPABILITY,
          INSTANCE_CAPABILITY,
          AGENT_MESSAGE_CAPABILITY,
          AGENT_ACTIVITY_CAPABILITY,
          AGENT_HISTORY_CAPABILITY,
          STEER_CAPABILITY,
          RESUME_CAPABILITY,
        ],
        browserId: state.browserId,
        runtimeEpoch,
        ...(helloResume ? { resume: helloResume } : {}),
      });
      handshakeTimer = setTimeout(() => {
        if (gen !== generation || loopReady) return;
        recordLifecycle('transport-error', { level: 'error', code: 'PROTOCOL_MISMATCH' });
        state.error = 'ui.error.protocolMismatch';
        ws.close(4002, 'agent-loop-v1 required');
      }, HANDSHAKE_TIMEOUT_MS);
      publish();
    };
    ws.onclose = (ev) => {
      if (gen === generation) sharing.revoke();
      if (gen !== generation) return;
      state.connected = false;
      recordDiagnostic('socket-close', 'remote_disconnect', {
        closeCode: ev.code >= 1000 && ev.code <= 4999 ? ev.code : undefined,
      });
      const terminalClose = [4001, 4002, 4004, 4005].includes(ev.code);
      const freshRetry = ev.code === 4005 && !freshRecoveryAttempted;
      if (freshRetry) freshRecoveryAttempted = true;
      reconnectBlocked = terminalClose && !freshRetry;
      const recoverable = resumeReady && !terminalClose && !!resumeDescriptor();
      if (recoverable) {
        if (!recoveryDeadline) {
          recoveryDeadline = Date.now() + recoveryWindowMs;
          recoveryTimer = setTimeout(
            () => failRecovery('ui.error.taskRecoveryExpired'),
            recoveryWindowMs,
          );
        }
        setRecovery('disconnected');
        state.error = '';
      } else if (loop.active || recoveryDeadline) failRecovery();
      loopReady = false;
      controlRecoveryReady = false;
      state.steeringSupported = false;
      interruptReady = false;
      clearTimeout(handshakeTimer);
      if (!recoverable) preview.finish('interrupted');
      socket = null;
      state.connected = false;
      state.endpointId = '';
      state.connecting = false;
      if (!recoverable) {
        idem.cancel();
        activity.end('interrupted');
      }
      // 4001 = a newer socket of this same installation; do not fight it.
      if (ev.code === 4002) state.error = 'ui.error.protocolMismatch';
      else if (ev.code === 4001) state.error = 'ui.error.connectionTaken';
      else if (ev.code === 1006 && !recoverable && !state.error)
        state.error = 'ui.error.connectionRejected';
      publish();
      if (!reconnectBlocked) scheduleReconnect();
    };
    ws.onerror = () => {
      if (gen !== generation) return;
      recordLifecycle('transport-error', { level: 'error', code: 'SOCKET_ERROR' });
      state.error = state.error || 'ui.error.connectionFailed';
      publish();
    };
    ws.onmessage = (ev) => {
      if (gen !== generation) return;
      void onFrame(String(ev.data), gen);
    };
  }

  async function onFrame(raw: string, gen: number) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      recordLifecycle('transport-error', { level: 'warn', code: 'BAD_PARAMS' });
      return;
    }
    const frame = relayFrameSchema.safeParse(parsed);
    if (!frame.success) {
      recordLifecycle('transport-error', { level: 'warn', code: 'BAD_PARAMS' });
      return;
    }
    const m = frame.data;
    switch (m.type) {
      case 'ready':
        clearTimeout(handshakeTimer);
        if (m.resume?.status === 'rejected') {
          failRecovery();
          socket?.close(4005, 'task resume rejected');
          return;
        }
        if (
          !m.capabilities.includes('agent-loop-v1') ||
          !m.capabilities.includes(INSTANCE_CAPABILITY) ||
          !m.capabilities.includes(AGENT_MESSAGE_CAPABILITY) ||
          m.endpointId !== `${state.keyId}.${state.browserId}`
        ) {
          state.error = 'ui.error.protocolMismatch';
          recordLifecycle('transport-error', { level: 'error', code: 'PROTOCOL_MISMATCH' });
          socket?.close(4002, 'agent-message-v2 and matching browser endpoint required');
          return;
        }
        if (
          helloResume &&
          (!m.capabilities.includes(RESUME_CAPABILITY) ||
            m.runtimeEpoch !== runtimeEpoch ||
            m.resume?.status !== 'resumed' ||
            !recoveryDeadline ||
            Date.now() >= recoveryDeadline)
        ) {
          failRecovery();
          socket?.close(4005, 'task resume mismatch');
          return;
        }
        resumeReady =
          m.capabilities.includes(RESUME_CAPABILITY) &&
          m.runtimeEpoch === runtimeEpoch &&
          !!m.resume;
        recoveryWindowMs = Math.min(RECOVERY_WINDOW_MS, m.recoveryWindowMs ?? RECOVERY_WINDOW_MS);
        if (recoveryDeadline) {
          clearTimeout(recoveryTimer);
          recoveryDeadline = 0;
          setRecovery('restored');
          state.error = '';
        }
        state.endpointId = m.endpointId;
        recordLifecycle('transport-ready');
        attachmentsReady = m.capabilities.includes(ATTACHMENT_CAPABILITY);
        state.steeringSupported = m.capabilities.includes(STEER_CAPABILITY);
        interruptReady = m.capabilities.includes(INTERRUPT_CAPABILITY);
        loopReady = true;
        controlRecoveryReady = m.capabilities.includes(CONTROL_RECOVERY_CAPABILITY);
        freshRecoveryAttempted = false;
        state.connected = true;
        state.connecting = false;
        if (resumeReady) for (const frame of outbox.values()) sendRaw(frame);
        wakeTransport();
        publish();
        return;
      case 'task-ack':
        if (m.runtimeEpoch === runtimeEpoch && outbox.delete(m.deliveryId)) publish();
        return;
      case 'agent-activity':
        if (
          !state.connected ||
          !loop.active ||
          m.endpointId !== state.endpointId ||
          m.taskId !== loop.taskId
        )
          return;
        if (state.agentActivity?.taskId === m.taskId && m.sequence <= state.agentActivity.sequence)
          return;
        {
          const { events, dropped, ...current } = m;
          state.agentActivity = { ...current, receivedAt: Date.now() };
          const entry = state.chat.find((item) => item.role === 'user' && item.id === m.taskId);
          if (entry?.agentHistory && (events?.length || dropped)) {
            appendAgentEvents(entry.agentHistory, events ?? [], dropped);
            pruneAgentHistory(state.chat);
            activityChanged();
          } else publish();
        }
        return;
      case 'agent-stop-result':
        if (pendingStop?.taskId === m.taskId) pendingStop.resolve(m.ok);
        return;
      case 'agent-status':
        if (loop.pendingId !== m.requestId) return;
        if (m.state === 'queued') await updateDelivery({ state: 'queued', chatId: loop.taskId });
        else {
          await updateDelivery({ state: m.state, chatId: loop.taskId, code: m.code });
          loop.fail(m.requestId, m.code || 'AGENT_UNAVAILABLE');
        }
        return;
      case 'agent-input-status': {
        if (loop.taskId !== m.taskId) return;
        const entry = state.chat.find((item) => item.id === m.inputId && item.taskId === m.taskId);
        if (!entry) return;
        if (entry.steerStatus === 'applied' && m.state !== 'queued') return;
        if (m.state === 'queued' && entry.steerStatus === 'pending') entry.steerStatus = 'sent';
        // Fail closed when any owner input cannot be delivered. Do not continue
        // browser actions under a goal that silently omitted a user instruction.
        if (m.state !== 'queued') loop.fail(loop.inputId!, m.code || 'AGENT_UNAVAILABLE');
        await updateDelivery({ state: m.state, chatId: m.inputId, code: m.code });
        return;
      }
      case 'ping':
        send({ type: 'pong', ts: m.ts ?? Date.now() });
        return;
      case 'req':
        await onRequest(m, gen);
        return;
    }
  }

  async function onRequest(
    m: {
      id: number;
      method: string;
      params: Record<string, unknown>;
      requestId?: string;
      deadline?: number;
    },
    gen: number,
  ) {
    const diagnostic = diagnosticRequest(m.method);
    const reply = (frame: Record<string, unknown>) => {
      const { captureEpoch, ...metadata } = diagnostic;
      if (captureEpoch === diagnosticsEpoch())
        recordLifecycle('response', {
          ...metadata,
          status: frame.type === 'error' ? 'error' : 'success',
          level: frame.type === 'error' ? 'warn' : 'debug',
          ...(frame.type === 'error' ? safeError({ code: frame.code }) : {}),
        });
      if (gen === generation) send({ id: m.id, ...frame });
    };
    if (m.method === 'diagnostics.detail.fetch') {
      try {
        z.object({}).strict().parse(m.params);
        if (gen !== generation) throw new Error('DETAIL_SHARE_UNAVAILABLE');
        reply({ type: 'resp', result: sharing.fetch(shareContext()) });
      } catch {
        reply({
          type: 'error',
          code: 'DETAIL_SHARE_UNAVAILABLE',
          message: 'No authorized diagnostic snapshot',
        });
      }
      return;
    }
    if (m.method === 'diagnostics.get') {
      try {
        reply({ type: 'resp', result: await getDiagnostics(m.params) });
      } catch (error) {
        reply({
          type: 'error',
          code:
            error instanceof z.ZodError
              ? 'BAD_PARAMS'
              : safeError(error).code === 'DIAGNOSTICS_RESET'
                ? 'DIAGNOSTICS_RESET'
                : 'DIAGNOSTICS_UNAVAILABLE',
          message: 'Diagnostics request failed',
        });
      }
      return;
    }
    if (m.method === 'agent-decision') {
      try {
        if (!state.connected || !loopReady)
          throw Object.assign(new Error('Transport handshake is not ready'), {
            code: 'EXT_OFFLINE',
          });
        const { id, decision, inputId } = z
          .object({
            id: z.string().max(128),
            decision: z.unknown(),
            inputId: z.string().max(128).optional(),
          })
          .strict()
          .parse(m.params);
        reply({ type: 'resp', result: loop.accept(id, decision, inputId) });
      } catch (error) {
        const e = error as { code?: string; message?: string };
        reply({
          type: 'error',
          code: error instanceof z.ZodError ? 'BAD_DECISION' : e.code || 'EXT_ERROR',
          message: e.message?.slice(0, 1500),
        });
      }
      return;
    }
    reply({
      type: 'error',
      code: 'UNKNOWN_METHOD',
      message: 'Only correlated Agent decisions are accepted',
    });
  }

  // ---------------------------------------------------------------- config
  async function applyConfig(next: RemoteConfig) {
    if (
      next.key !== config.key ||
      next.relayUrl !== config.relayUrl ||
      next.enabled !== config.enabled
    )
      detailed.clear();
    if (config.key && (next.key !== config.key || next.relayUrl !== config.relayUrl))
      await setDiagnosticsEnabled(false);
    const changed =
      next.relayUrl !== config.relayUrl ||
      next.key !== config.key ||
      next.enabled !== config.enabled;
    config = next;
    state.keyId = config.key ? await keyIdOf(config.key) : '';
    snapshot();
    if (!changed) return;
    clearPageContexts();
    disconnect('config changed');
    backoff = BACKOFF_MIN_MS;
    if (!config.enabled) {
      // Kill switch: the owner flipped it, so end any task too.
      idem.cancel();
      await release(true, false, 'config_disabled').catch(() => {});
      state.error = '';
      publish();
      return;
    }
    void connect();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LANGUAGE_STORAGE_KEY])
      setWorkerLanguage(changes[LANGUAGE_STORAGE_KEY].newValue);
  });

  // ---------------------------------------------------------------- boot
  const boot = (async () => {
    await initializeDiagnostics().catch(() => setDiagnosticsEnabled(false).catch(() => {}));
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
    await recoverTasks();
    const saved = await diagnosticStorage('read', () =>
      chrome.storage.local.get([
        REMOTE_CONFIG_KEY,
        REMOTE_BROWSER_ID_KEY,
        REMOTE_CHAT_LOG_KEY,
        LANGUAGE_STORAGE_KEY,
      ]),
    );
    const storedBrowserId = saved[REMOTE_BROWSER_ID_KEY];
    state.browserId =
      typeof storedBrowserId === 'string' && BROWSER_ID_RE.test(storedBrowserId)
        ? storedBrowserId
        : crypto.randomUUID();
    // Persist before dialing: failure must not create a new identity every reconnect.
    if (state.browserId !== storedBrowserId)
      await diagnosticStorage('write', () =>
        chrome.storage.local.set({ [REMOTE_BROWSER_ID_KEY]: state.browserId }),
      );
    setWorkerLanguage(saved[LANGUAGE_STORAGE_KEY]);
    const cfg = remoteConfigSchema.safeParse(saved[REMOTE_CONFIG_KEY] ?? {});
    const log = z.array(chatEntrySchema).safeParse(saved[REMOTE_CHAT_LOG_KEY] ?? []);
    state.chat = log.success ? log.data.slice(-CHAT_LOG_CAP) : [];
    for (const message of state.chat) {
      if (message.loopStatus === 'active') message.loopStatus = 'interrupted';
      if (message.agentHistory?.status === 'running') {
        message.agentHistory.status = 'interrupted';
        message.agentHistory.endedAt = message.agentHistory.events.at(-1)?.at ?? message.ts;
      }
      if (message.steerStatus === 'pending' || message.steerStatus === 'sent')
        message.steerStatus = 'interrupted';
    }
    await persistChat();
    if (activity.recover()) await persistChat();
    await applyConfig(cfg.success ? cfg.data : remoteConfigSchema.parse({}));
    if (config.enabled && state.configured) void connect();
    publish();
  })();
  void boot.catch((e) => {
    recordLifecycle('runtime-error', { level: 'error', ...safeError(e) });
    state.error = `ui.error.initializationFailed\n${panelErrorMessage(e)}`;
    publish();
  });

  // Chrome 116+ keeps the worker alive on WebSocket traffic (the relay pings
  // every 17s); the alarm is the backstop that re-dials after the worker was
  // recycled while offline. 30s is the MV3 floor.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    void boot.then(() => {
      expireDiagnostics();
      if (
        !socket &&
        config.enabled &&
        state.configured &&
        !['ui.error.protocolMismatch', 'ui.error.connectionTaken'].includes(state.error)
      )
        void connect();
    });
  });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // ---------------------------------------------------------------- panel
  chrome.runtime.onMessage.addListener((raw, sender, reply) => {
    if (!isPanelSender(sender)) return false;
    const parsed = remoteRequestSchema.safeParse(raw);
    if (!parsed.success) return false;
    const run = async () => {
      await boot;
      const m = parsed.data;
      switch (m.type) {
        case 'remote-detailed-set-enabled':
          if (m.enabled) detailed.enable();
          else detailed.clear();
          return snapshot();
        case 'remote-detailed-preview':
          return incidentPreview(m.consent);
        case 'remote-detail-share-prepare': {
          const result = await sharing.prepare(incidentPreview(m.consent), shareContext());
          if (!detailed.valid(m.consent)) {
            sharing.revoke();
            throw new Error('ui.error.detailedExpired');
          }
          return result;
        }
        case 'remote-detail-share-grant':
          return sharing.grant(m.id, shareContext());
        case 'remote-detail-share-revoke':
          sharing.revoke();
          return { revoked: true };
        case 'remote-detailed-validate':
          return { valid: detailed.valid(m.consent) };
        case 'remote-detailed-event':
          return { accepted: detailed.append(m.consent, 'sidepanel', m.event, detailedContext()) };
        case 'remote-diagnostics-event':
          return { accepted: acceptPanelDiagnostic(m.consent, m.event) };
        case 'remote-diagnostics-set-enabled':
          await setDiagnosticsEnabled(m.enabled);
          publish();
          return snapshot();
        case 'remote-state':
          return snapshot();
        case 'remote-save': {
          const next = remoteConfigSchema.parse({
            relayUrl: m.relayUrl.trim(),
            key: m.key.trim(),
            enabled: config.enabled,
          });
          if (!next.relayUrl || !next.key) throw new Error('ui.error.credentialsRequired');
          // Revoke sharing before persisting a different recipient. A worker
          // suspension between these writes must never expose the old records.
          if (next.key !== config.key || next.relayUrl !== config.relayUrl) {
            detailed.clear();
            await setDiagnosticsEnabled(false);
          }
          await diagnosticStorage('write', () =>
            chrome.storage.local.set({ [REMOTE_CONFIG_KEY]: next }),
          );
          await applyConfig(next);
          return snapshot();
        }
        case 'remote-set-enabled': {
          if (config.enabled !== m.enabled) detailed.clear();
          const next = { ...config, enabled: m.enabled };
          await diagnosticStorage('write', () =>
            chrome.storage.local.set({ [REMOTE_CONFIG_KEY]: next }),
          );
          await applyConfig(next);
          return snapshot();
        }
        case 'remote-chat-send': {
          if (!state.connected || !loopReady) throw new Error('ui.error.messageNotSent');
          if (completionPending()) throw new Error('ui.error.taskCompletionPending');
          const text = messageText(m.message).trim();
          if (!text) throw new Error('ui.error.emptyMessage');
          if (sendingChat || stopTaskPromise) throw new Error('ui.error.chatBusy');
          if (loop.active && !state.steeringSupported) throw new Error('ui.error.steerUnsupported');
          const attachments = messageAttachments(m.message);
          if (!attachmentsReady && attachments.some((a) => a.type !== 'quote'))
            throw new Error('ui.error.attachmentsUnsupported');
          sendingChat = true;
          try {
            const gen = generation;
            const revision = chatRevision;
            const originalTask = loop.taskId;
            publish();
            if (gen !== generation || revision !== chatRevision || !loopReady)
              throw new Error('ui.error.sendFailed');
            const id = crypto.randomUUID();
            const ts = Date.now();
            const { context, page } = await captureCurrentPage(
              id,
              m.windowId,
              m.tabId,
              attachments.filter((a) => a.type === 'quote').map(attachmentSelection),
            );
            if (gen !== generation || revision !== chatRevision || !loopReady) {
              forgetPageContext(id);
              throw new Error('ui.error.sendFailed');
            }
            if (loop.settling) await loop.settling;
            if (completionPending()) {
              forgetPageContext(id);
              throw new Error('ui.error.taskCompletionPending');
            }
            if (
              gen !== generation ||
              revision !== chatRevision ||
              !loopReady ||
              (loop.active && loop.taskId !== originalTask)
            ) {
              forgetPageContext(id);
              throw new Error('ui.error.sendFailed');
            }
            if (loop.active) {
              let taskId: string;
              try {
                taskId = loop.steer(id, m.message, context);
              } catch (error) {
                forgetPageContext(id);
                throw error;
              }
              await appendChat({
                id,
                role: 'user',
                text,
                ts,
                delivery: 'sent',
                page,
                taskId,
                steerStatus: 'pending',
                ...(attachments.length
                  ? { attachments: storedAttachments(attachments, m.imagePreviews) }
                  : {}),
              }).catch(() => {
                // The update has already been sent. A history-write failure
                // must not invite a retry that applies the same intent twice.
                state.error = 'ui.error.chatSaveFailed';
                publish();
              });
              return snapshot();
            }
            await appendChat({
              id,
              role: 'user',
              text,
              ts,
              delivery: 'sent',
              page,
              ...(attachments.length
                ? { attachments: storedAttachments(attachments, m.imagePreviews) }
                : {}),
              loopStatus: 'active',
              agentHistory: { status: 'running', startedAt: ts, events: [], dropped: 0 },
            });
            if (gen !== generation || revision !== chatRevision || !loopReady) {
              forgetPageContext(id);
              const message = state.chat.find((entry) => entry.id === id);
              if (message) {
                message.loopStatus = 'interrupted';
                if (message.agentHistory) {
                  message.agentHistory.status = 'interrupted';
                  message.agentHistory.endedAt = Date.now();
                }
                await persistChat();
              }
              throw new Error('ui.error.sendFailed');
            }
            startDiagnosticTask();
            try {
              setRecovery(undefined);
              state.error = '';
              loop.start(id, m.message, context);
            } catch (error) {
              endDiagnosticTask('interrupted', true);
              throw error;
            }
            return snapshot();
          } finally {
            sendingChat = false;
            publish();
          }
        }
        case 'remote-chat-clear':
          if (loop.active) {
            cancelLoop('stopped');
            await completeTask();
          }
          preview.clear();
          state.chat = [];
          await persistChat();
          publish();
          return snapshot();
        case 'remote-reveal':
          await revealTask();
          return snapshot();
        case 'remote-preview-reveal':
          await preview.reveal();
          return snapshot();
        case 'remote-stop':
          await stopCurrentTask();
          return snapshot();
      }
    };
    // A second panel must not re-enable sharing between recipient revocation
    // and the durable connection update. Serialize these whole transactions.
    const mutatesConsent = [
      'remote-save',
      'remote-set-enabled',
      'remote-diagnostics-set-enabled',
      'remote-detailed-set-enabled',
      'remote-detail-share-prepare',
      'remote-detail-share-grant',
      'remote-detail-share-revoke',
    ].includes(parsed.data.type);
    const pending = mutatesConsent ? panelMutations.catch(() => {}).then(run) : run();
    if (mutatesConsent) panelMutations = pending;
    void pending.then(
      (value) => reply({ ok: true, value }),
      (e) => {
        const message =
          e instanceof z.ZodError
            ? e.issues.map((i) => i.message).join('；')
            : panelErrorMessage(e);
        reply({ ok: false, error: message });
      },
    );
    return true;
  });
}
