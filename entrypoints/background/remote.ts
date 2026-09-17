import { LANGUAGE_STORAGE_KEY, setWorkerLanguage } from '../../utils/i18n';
// zylos-remote transport. Dials out to a zylos-browser-remote relay with
// `relayUrl + key`, answers `req` frames through the executor, and carries the
// side-panel chat both ways. Nothing here trusts the relay: params are
// re-validated, URLs are re-screened, and the debugger is only ever attached to
// task-owned tabs or the current page explicitly associated with a panel message.
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
  REMOTE_CHAT_LOG_KEY,
  REMOTE_CHAT_RECEIPTS_KEY,
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
import {
  IdempotencyCache,
  REMOTE_CAPABILITIES,
  RemoteError,
  dispatch,
} from '../../utils/remote-commands';
import { z } from 'zod';
import { ToolActivity } from '../../utils/tool-activity';
import { LivePreview } from '../../utils/automation/live-preview';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const KEEPALIVE_ALARM = 'remote-keepalive';
const MAX_INFLIGHT = 8;

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
  const inflight = new Map<number, { method: string }>();
  const receivingChats = new Map<string, Promise<void>>();
  const receivedChats = new Set<string>();

  const publish = () => {
    preview.sync(currentControl(), currentGrant(), state.connected);
    void chrome.runtime.sendMessage({ type: 'remote-updated', state: snapshot() }).catch(() => {});
  };
  function snapshot(): RemoteState {
    const control = currentControl();
    const grant = currentGrant();
    const previous =
      state.task?.sessionId === control?.sessionId && state.task?.tabId === control?.tabId
        ? state.task
        : null;
    const running = [...inflight.values()].some(
      ({ method }) =>
        !['info', 'describe', 'tabs', 'pause', 'finish', 'stop', 'finalize'].includes(method),
    );
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
  onState(publish);

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

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (!config.enabled || !state.configured) return;
    const jitter = Math.floor(Math.random() * 500);
    reconnectTimer = setTimeout(() => void connect(), backoff + jitter);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  function disconnect(reason: string) {
    preview.finish('interrupted');
    clearTimeout(reconnectTimer);
    generation++;
    const old = socket;
    socket = null;
    state.connected = false;
    state.connecting = false;
    inflight.clear();
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
      state.connected = true;
      state.connecting = false;
      state.error = '';
      send({ type: 'hello', version: REMOTE_VERSION, capabilities: REMOTE_CAPABILITIES });
      publish();
    };
    ws.onclose = (ev) => {
      if (gen !== generation) return;
      preview.finish('interrupted');
      socket = null;
      state.connected = false;
      state.connecting = false;
      inflight.clear();
      idem.cancel();
      activity.end('interrupted');
      // 4001 = superseded by a newer socket of ours (another window / reload); do not fight it.
      if (ev.code === 4001) state.error = 'ui.error.connectionTaken';
      else if (ev.code === 1006 && !state.error) state.error = 'ui.error.connectionRejected';
      publish();
      if (ev.code !== 4001) scheduleReconnect();
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
      case 'ping':
        send({ type: 'pong', ts: m.ts ?? Date.now() });
        return;
      case 'chat': {
        const receive = async () => {
          let completion: Promise<void> | undefined;
          if (m.role === 'assistant' && m.final) {
            preview.finish('completed');
            idem.cancel();
            activity.end('completed');
            completion = completeTask().catch(() => {
              preview.finish('error');
              state.error = 'ui.error.taskCleanupFailed';
              publish();
            });
          }
          await appendChat({
            id: m.id,
            role: m.role,
            text: m.text,
            ts: m.ts ?? Date.now(),
            final: m.final,
          });
          await completion;
          if (m.id) {
            const receipts = [...receivedChats, m.id].slice(-500);
            await chrome.storage.local.set({ [REMOTE_CHAT_RECEIPTS_KEY]: receipts });
            receivedChats.clear();
            receipts.forEach((id) => receivedChats.add(id));
          }
        };
        try {
          const pending = m.id && receivingChats.get(m.id);
          if (pending) await pending;
          else if (!m.id || !receivedChats.has(m.id)) {
            const work = receive();
            if (m.id) receivingChats.set(m.id, work);
            try {
              await work;
            } finally {
              if (m.id) receivingChats.delete(m.id);
            }
          }
          // A duplicate after a lost acknowledgement must not end a newer task.
          if (state.error === 'ui.error.chatSaveFailed') {
            state.error = '';
            publish();
          }
          if (m.id && gen === generation) send({ type: 'chat-ack', id: m.id });
        } catch {
          state.error = 'ui.error.chatSaveFailed';
          publish();
        }
        return;
      }
      case 'chat-status':
        await updateDelivery(m);
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
    const step = activity.begin(m.method, m.params);
    if (inflight.has(m.id)) {
      step?.finish('DUPLICATE_ID');
      return reply({ type: 'error', code: 'DUPLICATE_ID', message: 'id already in flight' });
    }
    if (inflight.size >= MAX_INFLIGHT) {
      step?.finish('BUSY');
      return reply({
        type: 'error',
        code: 'BUSY',
        message: `more than ${MAX_INFLIGHT} commands in flight`,
      });
    }
    const active = { method: m.method };
    inflight.set(m.id, active);
    publish();
    try {
      const result = await dispatch(
        {
          method: m.method,
          params: m.params,
          requestId: m.requestId,
          deadline: m.deadline,
          keyId: state.keyId,
        },
        idem,
        () => {
          step?.start();
          publish();
        },
        () => {
          preview.resume(m.method);
          publish();
        },
      );
      const replayed = !!(
        result &&
        typeof result === 'object' &&
        'replayed' in result &&
        result.replayed
      );
      if (gen === generation && !replayed) preview.result(m.method, false);
      step?.finish(undefined, replayed);
      if (m.method === 'stop' && gen === generation) step?.stop();
      reply({ type: 'resp', result });
    } catch (e) {
      if (gen === generation) preview.result(m.method, true);
      const code =
        e instanceof z.ZodError
          ? 'BAD_PARAMS'
          : e && typeof e === 'object' && 'code' in e && typeof e.code === 'string'
            ? e.code
            : 'EXT_ERROR';
      step?.finish(code);
      if (e instanceof RemoteError)
        reply({ type: 'error', code: e.code, message: e.message, details: e.details });
      else if (e instanceof z.ZodError)
        reply({
          type: 'error',
          code: 'BAD_PARAMS',
          message: e.issues.map((i) => i.message).join('; '),
        });
      else {
        const err = e as { code?: string; message?: string };
        reply({
          type: 'error',
          code: typeof err?.code === 'string' ? err.code : 'EXT_ERROR',
          message: err?.message || 'extension error',
        });
      }
    } finally {
      // A previous socket's late result must not clear a new request with the same id.
      if (inflight.get(m.id) === active) inflight.delete(m.id);
      publish();
    }
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
      REMOTE_CHAT_LOG_KEY,
      REMOTE_CHAT_RECEIPTS_KEY,
      LANGUAGE_STORAGE_KEY,
    ]);
    setWorkerLanguage(saved[LANGUAGE_STORAGE_KEY]);
    const cfg = remoteConfigSchema.safeParse(saved[REMOTE_CONFIG_KEY] ?? {});
    const log = z.array(chatEntrySchema).safeParse(saved[REMOTE_CHAT_LOG_KEY] ?? []);
    state.chat = log.success ? log.data.slice(-CHAT_LOG_CAP) : [];
    if (activity.recover()) await persistChat();
    const receipts = z.array(z.string().max(128)).safeParse(saved[REMOTE_CHAT_RECEIPTS_KEY] ?? []);
    if (receipts.success) for (const id of receipts.data.slice(-500)) receivedChats.add(id);
    for (const message of state.chat) {
      if (message.role === 'assistant' && message.id) receivedChats.add(message.id);
    }
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
      if (!socket && config.enabled && state.configured) void connect();
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
          if (!state.connected) throw new Error('ui.error.messageNotSent');
          const text = m.text.trim();
          if (!text) throw new Error('ui.error.emptyMessage');
          const id = crypto.randomUUID();
          const ts = Date.now();
          const gen = generation;
          const { context, page } = await captureCurrentPage(id, m.windowId, m.tabId);
          if (gen !== generation || !send({ type: 'chat', id, text, ts, context })) {
            forgetPageContext(id);
            throw new Error('ui.error.sendFailed');
          }
          await appendChat({ id, role: 'user', text, ts, delivery: 'sent', page });
          return snapshot();
        }
        case 'remote-chat-clear':
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
