import {
  attach,
  release,
  execute,
  currentGrant,
  currentControl,
  onState,
  initializeExecutor,
  bindCdp,
  executeCdp,
  onCdpEvent,
  revealTask,
} from '../../utils/automation/executor';

import { normalizeEndpoint as normalize } from './endpoint';
import { cleanupWarning, recoverTasks } from '../../utils/automation/task-lifecycle';
import {
  isPanelSender,
  requestSchema,
  type PanelState,
  type ChatEntry,
  authorizationSchema,
} from '../../utils/messages';
import { AuthorizationController } from '../../utils/authorization';
import { z } from 'zod';
import { commandSchema } from '../../utils/commands';
import { cdpRequestSchema, cdpBindSchema } from '../../utils/cdp-protocol';

const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('authorization'), request: authorizationSchema }),
  cdpRequestSchema,
  cdpBindSchema,
  z.object({ type: z.literal('paired'), deviceId: z.string(), token: z.string() }),
  z.object({
    type: z.literal('ready'),
    deviceId: z.string(),
    history: z
      .array(
        z.object({
          id: z.string(),
          role: z.enum(['user', 'assistant']),
          text: z.string(),
          at: z.string(),
        }),
      )
      .optional(),
  }),
  z.object({
    type: z.literal('chat'),
    entry: z.object({
      id: z.string(),
      role: z.enum(['user', 'assistant']),
      text: z.string(),
      at: z.string(),
    }),
  }),
  z.object({ type: z.literal('chat-error'), error: z.string() }),
  z.object({ type: z.literal('chat-accepted') }),
  z.object({ type: z.literal('cancel'), id: z.string() }),
  z.object({
    type: z.literal('command'),
    id: z.string(),
    deadline: z.number(),
    command: commandSchema,
  }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('error'), error: z.unknown() }),
]);
type ServerMessage = z.infer<typeof serverMessageSchema>;

export function startBackground() {
  initializeExecutor();
  let socket: WebSocket | null = null;
  let ready = false;
  let connecting = false;
  let connectionError = '';
  let authBlocked = false;
  let connectionUrl = '';
  let status = '未连接';
  const credentialsSchema = z.object({
    url: z.string(),
    name: z.string(),
    deviceId: z.string(),
    token: z.string(),
  });
  type Credentials = { url: string; name: string; deviceId?: string; token?: string };
  let credentials: Credentials | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  const cdpPending = new Set<string>();
  let history: ChatEntry[] = [];
  let recent = new Map();
  let attempt = 0;
  const authorization = new AuthorizationController({
    publish,
    send,
    release,
    grant: async (windowId, check) => {
      if (!ready) throw new Error('Agent 未连接');
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      check();
      if (tab?.id === undefined) throw new Error('当前窗口没有可用标签页');
      await attach(tab.id, 'new');
      const control = currentControl();
      if (!control) throw new Error('授权未完成');
      return control.sessionId;
    },
  });
  const boot = (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    // Worker recovery never silently restores a grant. Detach only our recorded tab.
    const previous = await chrome.storage.session.get('grantedTabId');
    if (typeof previous.grantedTabId === 'number' && Number.isInteger(previous.grantedTabId))
      await chrome.debugger.detach({ tabId: previous.grantedTabId }).catch(() => {});
    await chrome.storage.session.remove('grantedTabId');
    await recoverTasks();
    await chrome.action.setBadgeText({ text: '' });
    const stored = await chrome.storage.local.get('connection');
    const saved = credentialsSchema.safeParse(stored.connection);
    credentials = saved.success ? saved.data : null;
    if (credentials) connect();
  })();
  void boot.catch(() => {
    connectionError = '无法读取连接信息，请重新加载插件后重试';
    publish();
  });
  function send(message: unknown) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  onCdpEvent((event) => {
    if (ready && new TextEncoder().encode(JSON.stringify(event)).byteLength < 1024 * 1024)
      send(event);
  });
  function publish() {
    void chrome.runtime.sendMessage({ type: 'ui-state', state: state() }).catch(() => {});
  }
  function state(): PanelState {
    return {
      ready,
      connecting,
      connectionError: connectionError || cleanupWarning(),
      hasSavedConnection: !!credentials?.token,
      status: authorization.waiting ? 'Agent 等待你确认浏览器授权' : status,
      deviceId: credentials?.deviceId,
      url: connectionUrl || credentials?.url || 'http://127.0.0.1:3460',
      tab: currentGrant(),
      control: currentControl(),
      history,
      authorization: authorization.state,
    };
  }
  onState((tab) => {
    if (
      !currentControl() &&
      ['approved', 'resume-failed'].includes(authorization.state?.status || '')
    )
      authorization.cancel();
    void chrome.storage.session.set({ grantedTabId: tab?.id ?? null });
    send({
      type: 'state',
      tab,
      control: currentControl(),
      capabilities: [
        'observe-v1',
        'finish-v1',
        'task-finalize-v1',
        'cdp-relay-v1',
        'task-tab-v1',
        'conversation-auth-v1',
      ],
    });
    publish();
  });
  function connect(pairCode?: string, target = credentials) {
    if (!target) return;
    authorization.cancel();
    const endpoint = normalize(target.url);
    clearTimeout(reconnectTimer);
    clearInterval(heartbeat);
    const old = socket;
    socket = null;
    old?.close();
    ready = false;
    void release();
    const ws = new WebSocket(endpoint);
    socket = ws;
    connectionUrl = target.url;
    connecting = true;
    connectionError = '';
    authBlocked = false;
    status = '正在连接…';
    publish();
    let timedOut = false;
    let paired = false;
    const deadline = setTimeout(() => {
      if (socket === ws && !ready) {
        timedOut = true;
        ws.close();
      }
    }, 8000);
    ws.onopen = () => {
      if (socket !== ws) return;
      send(
        pairCode
          ? { type: 'pair', code: pairCode, name: target.name }
          : { type: 'auth', deviceId: target.deviceId, token: target.token },
      );
    };
    // Process paired -> persisted credentials -> ready in order, even if the popup closes.
    let messages = Promise.resolve();
    ws.onmessage = (event) => {
      messages = messages
        .then(async () => {
          if (socket !== ws) return;
          const m = serverMessageSchema.parse(JSON.parse(event.data));
          if (m.type === 'paired') {
            const next = { ...target, deviceId: m.deviceId, token: m.token };
            await chrome.storage.local.set({ connection: next });
            if (socket !== ws) return;
            credentials = next;
            paired = true;
          } else {
            if (m.type === 'ready') clearTimeout(deadline);
            // Commands must not block stop/cancel messages behind a long operation.
            if (m.type === 'command' || m.type === 'cdp-command' || m.type === 'cdp-bind')
              void receive(m, ws).catch(() => {});
            else await receive(m, ws);
          }
        })
        .catch(() => {
          if (socket !== ws) return;
          connectionError = '无法处理或保存连接信息，请重新加载插件后重试';
          ws.close();
          publish();
        });
    };
    ws.onerror = () => {
      if (socket === ws) {
        connectionError = '无法连接 Agent，请检查地址和本地服务是否启动';
        publish();
      }
    };
    ws.onclose = (event) => {
      clearTimeout(deadline);
      if (socket !== ws) return;
      socket = null;
      ready = false;
      connecting = false;
      authorization.cancel();
      clearInterval(heartbeat);
      void release();
      const failedPair = !!pairCode && !paired;
      authBlocked = event.code === 1008 || failedPair;
      if (event.code === 1008)
        connectionError = failedPair
          ? '配对码无效、已使用或已过期。请在 Agent 终端重新运行 pair，复制新的 code。'
          : '连接凭证已失效或被撤销，请使用新的配对码连接。';
      else if (timedOut) connectionError = '连接超时，请检查 Agent 地址和服务状态';
      const willRetry = credentials?.token && !authBlocked;
      status = willRetry ? '已断开，正在自动重连…' : '未连接，暂时不能发送消息';
      if (failedPair && credentials?.token) connectionError += ' 原配对已保留，可点击“重新连接”。';
      publish();
      if (willRetry)
        reconnectTimer = setTimeout(
          () => connect(),
          Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)),
        );
    };
  }
  async function receive(m: ServerMessage, ws: WebSocket) {
    if (ws !== socket) return;
    if (m.type === 'authorization' && ready) {
      authorization.receive(m.request);
      return;
    }
    if (m.type === 'ready') {
      ready = true;
      connecting = false;
      connectionError = '';
      attempt = 0;
      recent.clear();
      status = '已连接 Agent';
      history = m.history || [];
      send({
        type: 'state',
        tab: currentGrant(),
        control: currentControl(),
        capabilities: [
          'observe-v1',
          'finish-v1',
          'task-finalize-v1',
          'cdp-relay-v1',
          'task-tab-v1',
          'conversation-auth-v1',
        ],
      });
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send({ type: 'ping' }), 20000);
      publish();
    }
    if (m.type === 'chat') {
      history = [...history.filter((x) => x.id !== m.entry.id), m.entry].slice(-50);
      publish();
    }
    if (m.type === 'chat-error') {
      status = `消息发送失败：${m.error}`;
      publish();
    }
    if (m.type === 'chat-accepted') {
      status = '消息已交给 Agent，等待回复';
      publish();
    }
    if (m.type === 'cancel') {
      authorization.cancel();
      await release();
      return;
    }
    if ((m.type === 'cdp-command' || m.type === 'cdp-bind') && ready) {
      if (cdpPending.has(m.id) || busy || cdpPending.size >= 32) {
        send({ type: 'cdp-response', id: m.id, ok: false, error: { code: 'BROWSER_BUSY' } });
        return;
      }
      cdpPending.add(m.id);
      try {
        const result = m.type === 'cdp-bind' ? await bindCdp(m) : await executeCdp(m);
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 8 * 1024 * 1024 - 1024)
          throw new Error('CDP_RESULT_TOO_LARGE');
        if (ws === socket) send({ type: 'cdp-response', id: m.id, ok: true, result });
      } catch (error) {
        if (ws === socket)
          send({
            type: 'cdp-response',
            id: m.id,
            ok: false,
            error: {
              code: error instanceof Error && 'code' in error ? String(error.code) : 'CDP_ERROR',
              message: (error instanceof Error ? error.message : 'CDP failed').slice(0, 1000),
            },
          });
      } finally {
        cdpPending.delete(m.id);
      }
      return;
    }
    if (m.type !== 'command' || !ready) return;
    if (m.command.op === 'stop') authorization.cancel();
    if (recent.has(m.id)) {
      send(recent.get(m.id));
      return;
    }
    let result;
    if ((busy || cdpPending.size > 0) && m.command.op !== 'stop')
      result = { type: 'result', id: m.id, ok: false, error: { code: 'BROWSER_BUSY' } };
    else {
      busy = true;
      try {
        if (!Number.isFinite(m.deadline) || m.deadline < Date.now())
          throw Object.assign(new Error('Command expired'), { code: 'COMMAND_EXPIRED' });
        result = {
          type: 'result',
          id: m.id,
          ok: true,
          result: await execute(m.command, m.deadline),
        };
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 8 * 1024 * 1024 - 1024)
          throw Object.assign(new Error('结果过大，请缩小窗口或减少页面内容后重新观察'), {
            code: 'RESULT_TOO_LARGE',
          });
      } catch (error) {
        result = {
          type: 'result',
          id: m.id,
          ok: false,
          error: {
            code: error instanceof Error && 'code' in error ? String(error.code) : 'BROWSER_ERROR',
            message: (error instanceof Error ? error.message : 'Browser operation failed').slice(
              0,
              1000,
            ),
          },
        };
      } finally {
        busy = false;
      }
    }
    // Cache only compact acknowledgements for images, never retain dozens of full screenshots.
    recent.set(
      m.id,
      (m.command.op === 'screenshot' || m.command.op === 'observe') && result.ok
        ? {
            type: 'result',
            id: m.id,
            ok: false,
            error: {
              code: 'RESULT_ALREADY_DELIVERED',
              message: 'Request a fresh observe or screenshot',
            },
          }
        : result,
    );
    if (recent.size > 100) recent.delete(recent.keys().next().value);
    if (ws === socket) send(result);
  }
  chrome.alarms.create('reconnect', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(() => {
    if (credentials?.token && !socket && !authBlocked) connect();
    if (!busy && cdpPending.size === 0)
      void recoverTasks(currentControl()?.sessionId)
        .then(publish)
        .catch(() => {});
  });
  chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, reply) => {
    // Privileged controls originate only from our bundled panel, never a website or content script.
    if (!isPanelSender(sender)) return false;
    const parsed = requestSchema.safeParse(rawMessage);
    if (!parsed.success) {
      reply({ ok: false, error: '无效的扩展请求，请重新加载插件' });
      return false;
    }
    const message = parsed.data;
    void (async () => {
      await boot;
      if (message.type === 'get-state') return state();
      if (message.type === 'approve-authorization') {
        if (!ready) throw new Error('请先连接 Agent');
        await authorization.approve(message.id, message.windowId);
        return state();
      }
      if (message.type === 'deny-authorization') {
        if (authorization.state?.id !== message.id) throw new Error('该授权请求已失效');
        authorization.cancel('denied');
        return state();
      }
      if (message.type === 'pair') {
        if (connecting) throw new Error('正在连接，请稍候');
        normalize(message.url);
        if (typeof message.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.code.trim()))
          throw new Error('请只粘贴 code 的值（43 位字符），不要包含引号或整段 JSON');
        // Never delete the last working credential before a replacement is accepted.
        connect(message.code.trim(), { url: message.url, name: 'My Chrome' });
        return state();
      }
      if (message.type === 'reconnect') {
        if (connecting) throw new Error('正在连接，请稍候');
        if (!credentials?.token) throw new Error('尚无已保存的配对，请先使用新的配对码连接');
        connect();
        return state();
      }
      if (message.type === 'grant') {
        if (!ready) throw new Error('请先连接 Agent');
        if (authorization.waiting || authorization.inFlight)
          throw new Error('请使用对话中的“允许并继续”完成本次授权');
        const [tab] = await chrome.tabs.query(
          Number.isInteger(message.windowId)
            ? { active: true, windowId: message.windowId }
            : { active: true, lastFocusedWindow: true },
        );
        if (!tab?.id) throw new Error('没有可授权的标签页');
        // Legacy panel messages narrow their former window grant to the explicit
        // current tab. New UI defaults to a separate, inactive work tab.
        await attach(tab.id, message.mode ?? (message.scope === 'task' ? 'new' : 'current'));
        return state();
      }
      if (message.type === 'reveal-task') {
        await revealTask();
        return state();
      }
      if (message.type === 'stop') {
        authorization.cancel();
        await release();
        return state();
      }
      if (message.type === 'disconnect') {
        authorization.cancel();
        credentials = null;
        clearTimeout(reconnectTimer);
        clearInterval(heartbeat);
        const ws = socket;
        socket = null;
        ws?.close();
        ready = false;
        connecting = false;
        connectionError = '';
        authBlocked = false;
        connectionUrl = '';
        await release();
        await chrome.storage.local.remove('connection');
        history = [];
        status = '已断开并忘记配对';
        publish(); // Every open surface must see the final cleared state.
        return state();
      }
      if (message.type === 'chat') {
        if (!ready) throw new Error('Agent 未连接');
        const text = String(message.text || '').trim();
        if (!text || text.length > 12000) throw new Error('消息长度需为 1–12000 字符');
        if (authorization.waiting) authorization.cancel();
        send({ type: 'chat', id: crypto.randomUUID(), text });
        return state();
      }
      throw new Error('Unknown action');
    })().then(
      (value) => reply({ ok: true, value }),
      (error) => reply({ ok: false, error: error.message }),
    );
    return true;
  });
}
