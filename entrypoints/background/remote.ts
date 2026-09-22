import { LANGUAGE_STORAGE_KEY, setWorkerLanguage } from '../../utils/i18n';
// Extension-owned conversations: request Agent decisions, execute locally, and
// return observations over the authenticated Remote connection.
import { captureCurrentPage, clearPageContexts, forgetPageContext } from '../../utils/page-context';
import {
  completeTask,
  currentControl,
  currentGrant,
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
  messageText,
  messageAttachments,
} from '../../utils/agent-message';
import {
  ATTACHMENT_CAPABILITY,
  attachmentSelection,
  storedAttachments,
} from '../../utils/attachments';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const KEEPALIVE_ALARM = 'remote-keepalive';
const HANDSHAKE_TIMEOUT_MS = 10000;

export function startRemoteBackground() {
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
  let attachmentsReady = false;
  let sendingChat = false;
  let chatRevision = 0;
  let loop: BrowserLoop;

  const publish = () => {
    preview.sync(currentControl(), currentGrant(), state.connected);
    void chrome.runtime.sendMessage({ type: 'remote-updated', state: snapshot() }).catch(() => {});
  };
  function snapshot(): RemoteState {
    state.loopActive = loop?.active ?? false;
    state.chatBusy = sendingChat || state.loopActive;
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
    if (hadControl && !hasControl && loop?.pendingId) {
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
      .then(() => chrome.storage.local.set({ [REMOTE_CHAT_LOG_KEY]: structuredClone(state.chat) }));
    saveQueue = saving;
    return saving;
  }
  const activity = new ToolActivity(
    () => state.chat,
    () => {
      publish();
      clearTimeout(activitySaveTimer);
      activitySaveTimer = setTimeout(() => {
        void persistChat().catch(() => {
          state.error = 'ui.error.chatSaveFailed';
          publish();
        });
      }, 250);
    },
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
  const send = (frame: Record<string, unknown>) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  };

  loop = new BrowserLoop({
    send: (request) => send({ type: 'agent-request', ...request }),
    cancel: () => idem.cancel(),
    error: () => {
      state.error = 'ui.error.chatSaveFailed';
      if (loop.taskId) send({ type: 'agent-turn-end', taskId: loop.taskId, status: 'interrupted' });
      setTimeout(publish, 0);
    },
    execute: (actions, assertActive, requestId) =>
      runBrowserRound(
        actions,
        async (method, params, id) => {
          assertActive();
          const taskId = loop.taskId;
          const step = activity.begin(method, params);
          step?.start();
          send({ type: 'agent-event', phase: 'start', taskId, id, method, params });
          try {
            const result = await dispatch(
              { method, params, requestId: id, deadline: Date.now() + 15000, keyId: state.keyId },
              idem,
              undefined,
              () => {
                preview.resume(method);
                publish();
              },
            );
            assertActive();
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
      ),
    finish: async (text, status, taskId) => {
      idem.cancel();
      preview.finish(status === 'done' ? 'completed' : 'error');
      activity.end(status === 'done' ? 'completed' : 'interrupted');
      await completeTask().catch(() => {
        state.error = 'ui.error.taskCleanupFailed';
      });
      if (loop.taskId !== taskId) return;
      const message = state.chat.find((entry) => entry.role === 'user' && entry.id === taskId);
      if (message) message.loopStatus = status;
      await appendChat({
        id: crypto.randomUUID(),
        role: 'assistant',
        text,
        final: true,
        ts: Date.now(),
      });
      send({ type: 'agent-turn-end', taskId, status, text });
      // BrowserLoop releases ownership after this durable completion callback.
      setTimeout(publish, 0);
    },
  });

  function cancelLoop(status: 'stopped' | 'interrupted') {
    chatRevision++; // Also invalidate a message still collecting its initial DOM excerpt.
    const taskId = loop.taskId;
    loop.cancel();
    if (taskId) {
      const message = state.chat.find((entry) => entry.role === 'user' && entry.id === taskId);
      if (message) message.loopStatus = status;
      send({ type: 'agent-turn-end', taskId, status });
      void persistChat().catch(() => {});
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (!config.enabled || !state.configured) return;
    const jitter = Math.floor(Math.random() * 500);
    reconnectTimer = setTimeout(() => void connect(), backoff + jitter);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  function disconnect(reason: string) {
    if (loop.active) {
      cancelLoop('interrupted');
      void completeTask().catch(() => {});
    }
    loopReady = false;
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
    if (!config.enabled || !state.configured) return;
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    const gen = ++generation;
    state.connecting = true;
    state.error = '';
    publish();
    let ws: WebSocket;
    try {
      ws = new WebSocket(config.relayUrl, [
        REMOTE_SUBPROTOCOL,
        `${REMOTE_KEY_PROTO_PREFIX}${config.key}`,
      ]);
    } catch (e) {
      state.connecting = false;
      state.error = 'ui.error.invalidRelayUrl';
      publish();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      if (gen !== generation) return;
      backoff = BACKOFF_MIN_MS;
      state.connected = false;
      state.connecting = true;
      state.error = '';
      send({
        type: 'hello',
        version: REMOTE_VERSION,
        capabilities: [...REMOTE_CAPABILITIES, INSTANCE_CAPABILITY, AGENT_MESSAGE_CAPABILITY],
        browserId: state.browserId,
      });
      handshakeTimer = setTimeout(() => {
        if (gen !== generation || loopReady) return;
        state.error = 'ui.error.protocolMismatch';
        ws.close(4002, 'agent-loop-v1 required');
      }, HANDSHAKE_TIMEOUT_MS);
      publish();
    };
    ws.onclose = (ev) => {
      if (gen !== generation) return;
      if (loop.active) {
        cancelLoop('interrupted');
        void completeTask().catch(() => {});
      }
      loopReady = false;
      clearTimeout(handshakeTimer);
      preview.finish('interrupted');
      socket = null;
      state.connected = false;
      state.endpointId = '';
      state.connecting = false;
      idem.cancel();
      activity.end('interrupted');
      // 4001 = a newer socket of this same installation; do not fight it.
      if (ev.code === 4002) state.error = 'ui.error.protocolMismatch';
      else if (ev.code === 4001) state.error = 'ui.error.connectionTaken';
      else if (ev.code === 1006 && !state.error) state.error = 'ui.error.connectionRejected';
      publish();
      if (![4001, 4002].includes(ev.code)) scheduleReconnect();
    };
    ws.onerror = () => {
      if (gen !== generation) return;
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
      return;
    }
    const frame = relayFrameSchema.safeParse(parsed);
    if (!frame.success) return;
    const m = frame.data;
    switch (m.type) {
      case 'ready':
        clearTimeout(handshakeTimer);
        if (
          !m.capabilities.includes('agent-loop-v1') ||
          !m.capabilities.includes(INSTANCE_CAPABILITY) ||
          !m.capabilities.includes(AGENT_MESSAGE_CAPABILITY) ||
          m.endpointId !== `${state.keyId}.${state.browserId}`
        ) {
          state.error = 'ui.error.protocolMismatch';
          socket?.close(4002, 'agent-message-v2 and matching browser endpoint required');
          return;
        }
        state.endpointId = m.endpointId;
        attachmentsReady = m.capabilities.includes(ATTACHMENT_CAPABILITY);
        loopReady = true;
        state.connected = true;
        state.connecting = false;
        publish();
        return;
      case 'agent-status':
        if (loop.pendingId !== m.requestId) return;
        if (m.state === 'queued') await updateDelivery({ state: 'queued', chatId: loop.taskId });
        else {
          await updateDelivery({ state: m.state, chatId: loop.taskId, code: m.code });
          loop.fail(m.requestId, m.code || 'AGENT_UNAVAILABLE');
        }
        return;
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
    const reply = (frame: Record<string, unknown>) => {
      if (gen === generation) send({ id: m.id, ...frame });
    };
    if (m.method === 'agent-decision') {
      try {
        const { id, decision } = z
          .object({ id: z.string().max(128), decision: z.unknown() })
          .strict()
          .parse(m.params);
        reply({ type: 'resp', result: loop.accept(id, decision) });
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
      await release().catch(() => {});
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
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
    await recoverTasks();
    const saved = await chrome.storage.local.get([
      REMOTE_CONFIG_KEY,
      REMOTE_BROWSER_ID_KEY,
      REMOTE_CHAT_LOG_KEY,
      LANGUAGE_STORAGE_KEY,
    ]);
    const storedBrowserId = saved[REMOTE_BROWSER_ID_KEY];
    state.browserId =
      typeof storedBrowserId === 'string' && BROWSER_ID_RE.test(storedBrowserId)
        ? storedBrowserId
        : crypto.randomUUID();
    // Persist before dialing: failure must not create a new identity every reconnect.
    if (state.browserId !== storedBrowserId)
      await chrome.storage.local.set({ [REMOTE_BROWSER_ID_KEY]: state.browserId });
    setWorkerLanguage(saved[LANGUAGE_STORAGE_KEY]);
    const cfg = remoteConfigSchema.safeParse(saved[REMOTE_CONFIG_KEY] ?? {});
    const log = z.array(chatEntrySchema).safeParse(saved[REMOTE_CHAT_LOG_KEY] ?? []);
    state.chat = log.success ? log.data.slice(-CHAT_LOG_CAP) : [];
    for (const message of state.chat)
      if (message.loopStatus === 'active') message.loopStatus = 'interrupted';
    await persistChat();
    if (activity.recover()) await persistChat();
    await applyConfig(cfg.success ? cfg.data : remoteConfigSchema.parse({}));
    if (config.enabled && state.configured) void connect();
    publish();
  })();
  void boot.catch((e) => {
    state.error = `ui.error.initializationFailed\n${e instanceof Error ? e.message : String(e)}`;
    publish();
  });

  // Chrome 116+ keeps the worker alive on WebSocket traffic (the relay pings
  // every 17s); the alarm is the backstop that re-dials after the worker was
  // recycled while offline. 30s is the MV3 floor.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    void boot.then(() => {
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
    void (async () => {
      await boot;
      const m = parsed.data;
      switch (m.type) {
        case 'remote-state':
          return snapshot();
        case 'remote-save': {
          const next = remoteConfigSchema.parse({
            relayUrl: m.relayUrl.trim(),
            key: m.key.trim(),
            enabled: config.enabled,
          });
          if (!next.relayUrl || !next.key) throw new Error('ui.error.credentialsRequired');
          await chrome.storage.local.set({ [REMOTE_CONFIG_KEY]: next });
          await applyConfig(next);
          return snapshot();
        }
        case 'remote-set-enabled': {
          const next = { ...config, enabled: m.enabled };
          await chrome.storage.local.set({ [REMOTE_CONFIG_KEY]: next });
          await applyConfig(next);
          return snapshot();
        }
        case 'remote-chat-send': {
          if (!state.connected || !loopReady) throw new Error('ui.error.messageNotSent');
          const text = messageText(m.message).trim();
          if (!text) throw new Error('ui.error.emptyMessage');
          if (sendingChat || loop.active) throw new Error('ui.error.chatBusy');
          const attachments = messageAttachments(m.message);
          if (!attachmentsReady && attachments.some((a) => a.type !== 'quote'))
            throw new Error('ui.error.attachmentsUnsupported');
          sendingChat = true;
          try {
            const gen = generation;
            const revision = chatRevision;
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
            await appendChat({
              id,
              role: 'user',
              text,
              ts,
              delivery: 'sent',
              page,
              ...(attachments.length ? { attachments: storedAttachments(attachments) } : {}),
              loopStatus: 'active',
            });
            if (gen !== generation || revision !== chatRevision || !loopReady) {
              forgetPageContext(id);
              const message = state.chat.find((entry) => entry.id === id);
              if (message) {
                message.loopStatus = 'interrupted';
                await persistChat();
              }
              throw new Error('ui.error.sendFailed');
            }
            loop.start(id, m.message, context);
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
          cancelLoop('stopped');
          preview.finish('stopped');
          clearPageContexts();
          idem.cancel();
          activity.end('stopped');
          // Revoking control must not depend on history storage being available.
          try {
            await release();
          } finally {
            await persistChat();
          }
          return snapshot();
      }
    })().then(
      (value) => reply({ ok: true, value }),
      (e) => {
        const message =
          e instanceof z.ZodError
            ? e.issues.map((i) => i.message).join('；')
            : e instanceof Error
              ? e.message
              : String(e);
        reply({ ok: false, error: message });
      },
    );
    return true;
  });
}
