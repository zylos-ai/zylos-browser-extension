import { z } from 'zod';
import {
  attach,
  release,
  execute,
  currentControl,
  currentGrant,
  onState,
  initializeExecutor,
  bindCdp,
  executeCdp,
  onCdpEvent,
  revealTask,
} from '../../utils/automation/executor';
import { recoverTasks, cleanupWarning } from '../../utils/automation/task-lifecycle';
import { isPanelSender } from '../../utils/messages';
import { commandSchema } from '../../utils/commands';
import { cdpRequestSchema, cdpBindSchema } from '../../utils/cdp-protocol';
import {
  platformApi,
  platformWeb,
  platformTaskSchema,
  platformUserSchema,
  platformRequestSchema,
  initialPlatformState,
  PlatformApiError,
  deviceAuthMessage,
  newerPlatformTask,
  browserOperationError,
  bindingCallbackAllowed,
  bindingConfirmationSchema,
  deviceProbeSchema,
  deviceProofSchema,
  chatActionSenderAllowed,
  type PlatformState,
  type PlatformTask,
} from '../../utils/platform';

const bindingSchema = z.object({
  access_token: z.string(),
  user: platformUserSchema,
  expires_at: z.string(),
  mode: z.literal('local-development'),
  confirmation: z
    .object({
      fingerprint: z.string(),
      nonce: z.string(),
      tabId: z.number().int(),
      expires: z.number(),
    })
    .optional(),
});
const loginSchema = z.object({
  version: z.literal(3),
  verifier: z.string(),
  nonce: z.string(),
  tabId: z.number().int().optional(),
  redeeming: z.boolean().optional(),
  expires: z.number(),
});
const random = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
const digest = async (s: string) =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))),
    ),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

export function startPlatformBackground() {
  initializeExecutor();
  let binding: z.infer<typeof bindingSchema> | null = null;
  let login: z.infer<typeof loginSchema> | null = null;
  let state: PlatformState = { ...initialPlatformState };
  let socket: WebSocket | null = null;
  let polling = false;
  let connecting = false;
  let generation = 0;
  let connection: { id: string; endpoint: string; epoch: string } | null = null;
  const proofs = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const journalSchema = z.record(
    z.object({ owner: z.string().uuid(), session: z.string().uuid(), recovered: z.boolean() }),
  );
  let journal: z.infer<typeof journalSchema> = {};
  async function markRecovered() {
    if (cleanupWarning() || currentControl()) return;
    let changed = false;
    for (const record of Object.values(journal)) {
      if (!record.recovered) {
        record.recovered = true;
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ platformTaskJournal: journal });
  }
  async function reconcileRecovery() {
    if (cleanupWarning() || currentControl()) return;
    for (const [id, record] of Object.entries(journal)) {
      if (!record.recovered || record.owner !== binding?.user.identity_id) continue;
      try {
        await api('/user/recover', { task_id: id, operation_id: crypto.randomUUID() });
        delete journal[id];
        await chrome.storage.local.set({ platformTaskJournal: journal });
      } catch {
        /* Closed state may arrive after the socket disconnect; retry reconciliation, never actions. */
      }
    }
  }
  let bindingInFlight: { fingerprint: string; promise: Promise<unknown> } | null = null;
  type Source = { taskId: string; tabId: number; windowId: number; expires: number };
  type Prepared = {
    taskId: string;
    session: string;
    activation: string;
    source: Source;
    started: boolean;
    starting: boolean;
  };
  const sources = new Map<string, Source>();
  let prepared: Prepared | null = null;
  let eventQueue: Promise<unknown> = Promise.resolve();
  const appliedEvents = new Set<string>();
  const inFlight = new Set<string>();
  const processed = new Set<string>();
  const snapshotState = () => {
    const control = currentControl();
    state.hasWorkTab = !!(
      !state.authRequired &&
      state.task &&
      ['running', 'waiting_user'].includes(state.task.state) &&
      control?.sessionId === state.task.control_session_id &&
      control.tabIds.length
    );
    return state;
  };
  const publish = () => {
    void chrome.runtime
      .sendMessage({ type: 'platform-updated', state: snapshotState() })
      .catch(() => {});
  };
  const send = (m: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          ...m,
          platformTaskId: state.task?.id,
          platformActivation: state.task?.activation_id,
          platformEpoch: connection?.epoch,
          preparedSession: prepared?.session,
        }),
      );
  };
  const sendState = () => {
    send({
      type: 'state',
      tab: currentGrant(),
      control: currentControl(),
      capabilities: ['cdp-relay-v1', 'task-tab-v1', 'task-finalize-v1', 'observe-v1', 'finish-v1'],
    });
    publish();
  };
  async function api(
    path: string,
    body?: unknown,
    credential = binding?.access_token,
  ): Promise<unknown> {
    const res = await fetch(platformApi + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential || ''}`,
        'X-Browser-Client': '1',
        'X-Browser-Extension': chrome.runtime.id,
        'X-Browser-Connection': connection?.id || '',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) {
      const code = z.object({ error: z.object({ code: z.string() }) }).parse(data).error.code;
      if (
        res.status === 401 &&
        binding &&
        binding.access_token === credential &&
        !path.includes('/redeem')
      ) {
        // 拒绝旧设备后立即停止本地控制，不删除凭据或自动恢复已撤销的授权。
        generation++;
        state.authRequired = true;
        state.connected = false;
        state.task = null;
        state.error = deviceAuthMessage;
        const oldSocket = socket;
        socket = null;
        connection = null;
        prepared = null;
        oldSocket?.close();
        await release()
          .then(markRecovered)
          .catch(() => {
            state.error = `${deviceAuthMessage} 请检查遗留工作标签。`;
          });
        await chrome.action.setBadgeText({ text: '!' });
        publish();
      }
      throw new PlatformApiError(code, res.status);
    }
    return z.object({ data: z.unknown() }).parse(data).data;
  }
  async function transition(t: PlatformTask, action: string, extra: Record<string, unknown> = {}) {
    const next = platformTaskSchema.parse(
      await api(`/tasks/${t.id}/${action}`, {
        revision: t.revision,
        operation_id: crypto.randomUUID(),
        ...extra,
      }),
    );
    state.task = newerPlatformTask(state.task, next);
    publish();
    return next;
  }
  async function cleanup(t: PlatformTask) {
    const c = currentControl();
    if (c && c.sessionId !== t.control_session_id) throw new Error('STALE_TASK');
    if (c) await execute({ op: 'finalize', taskId: c.sessionId, keep: [] }, Date.now() + 20000);
    else await release();
    if (t.state === 'finalizing')
      await transition(t, 'cleanup', { cleanup_state: cleanupWarning() ? 'partial' : 'confirmed' });
    if (!cleanupWarning()) {
      delete journal[t.id];
      await chrome.storage.local.set({ platformTaskJournal: journal });
    }
  }
  async function transitionFresh(
    task: PlatformTask,
    action: string,
    extra: Record<string, unknown>,
    validate: (current: PlatformTask) => void,
  ) {
    // touch/reveal 的提交可以先于 WS 通知。只重试服务端明确拒绝、没有提交的 CAS 冲突；
    // 超时、断线及丢失回执都不能重放建页操作。
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = platformTaskSchema.parse(await api(`/tasks/${task.id}`));
      if (
        current.id !== task.id ||
        current.owner_identity_id !== task.owner_identity_id ||
        current.endpoint_id !== task.endpoint_id ||
        current.connection_epoch !== task.connection_epoch ||
        current.activation_id !== task.activation_id ||
        current.control_session_id !== task.control_session_id ||
        current.source_id !== task.source_id
      )
        throw new Error('STALE_TASK');
      validate(current);
      try {
        return await transition(current, action, extra);
      } catch (error) {
        if (
          !(error instanceof PlatformApiError) ||
          error.status !== 409 ||
          error.code !== 'STALE_TASK' ||
          attempt === 2
        )
          throw error;
      }
    }
    throw new Error('STALE_TASK');
  }
  async function stopTask() {
    generation++;
    prepared = null;
    const t = state.task;
    // Revoke local execution before any network await, including API failure.
    // Stop fences this task, not the account's idle connection.
    await release();
    await markRecovered();
    if (t && t.state !== 'closed') {
      const next = await transitionFresh(t, 'stop', {}, () => {});
      if (next.state === 'finalizing') await cleanup(next);
    }
  }
  async function currentSenderTab(sender: chrome.runtime.MessageSender) {
    if (sender.tab?.id === undefined) return undefined;
    return chrome.tabs.get(sender.tab.id).catch(() => undefined);
  }
  async function requireChatSource(sender: chrome.runtime.MessageSender) {
    const tab = await currentSenderTab(sender);
    if (!chatActionSenderAllowed(sender, tab) || currentControl()?.tabIds.includes(sender.tab!.id!))
      throw new Error('INVALID_CHAT_SOURCE');
    return tab!;
  }
  async function sourceFor(t: PlatformTask) {
    const source = sources.get(t.source_id);
    if (!source || source.taskId !== t.id || source.expires <= Date.now())
      throw new Error('CHAT_SOURCE_EXPIRED');
    const tab = await chrome.tabs.get(source.tabId);
    if (
      tab.windowId !== source.windowId ||
      !chatActionSenderAllowed({ url: tab.url, frameId: 0, tab }, tab) ||
      currentControl()?.tabIds.includes(source.tabId)
    )
      throw new Error('INVALID_CHAT_SOURCE');
    return source;
  }
  async function applyTaskEvent(raw: unknown) {
    const event = z
      .object({
        eventId: z.string().regex(/^[0-9]+$/),
        task: platformTaskSchema,
        kind: z.string().optional(),
      })
      .parse(raw);
    if (appliedEvents.has(event.eventId)) {
      send({ type: 'platform-task-ack', eventId: event.eventId });
      return;
    }
    if (
      !binding ||
      event.task.endpoint_id !== connection?.endpoint ||
      event.task.connection_epoch !== connection?.epoch
    )
      throw new Error('CURRENT_BROWSER_MISMATCH');
    const incoming = platformTaskSchema.parse(await api('/tasks/' + event.task.id));
    if (state.task && state.task.id !== incoming.id && state.task.state !== 'closed' && prepared)
      throw new Error('BROWSER_BUSY');
    state.task = newerPlatformTask(state.task, incoming);
    const t = state.task!;
    if (t.state === 'preparing') {
      const source = await sourceFor(t);
      const c = currentControl();
      if (t.cleanup_state !== 'not_required' && c?.sessionId !== t.control_session_id) {
        await stopTask();
        throw new Error('TASK_CONTEXT_LOST');
      }
      source.expires = Date.parse(t.absolute_deadline);
      const epoch = ++generation;
      prepared = {
        taskId: t.id,
        session: t.control_session_id,
        activation: t.activation_id,
        source,
        started: !!c,
        starting: false,
      };
      // Context-ready does not require a tab, debugger, or page observation.
      await transition(t, 'ready', { control_session_id: t.control_session_id });
      if (generation !== epoch || prepared?.taskId !== t.id) throw new Error('STALE_TASK');
      state.error = '';
      sendState();
    } else if (t.state === 'closed') {
      if (prepared?.taskId === t.id || currentControl()?.sessionId === t.control_session_id) {
        generation++;
        prepared = null;
        await release();
        await markRecovered();
      }
    } else if (t.state === 'finalizing' && t.outcome === 'stopped') {
      await cleanup(t);
      prepared = null;
    } else if (event.kind === 'reveal' && snapshotState().hasWorkTab) {
      await revealTask();
    }
    appliedEvents.add(event.eventId);
    if (appliedEvents.size > 500) appliedEvents.delete(appliedEvents.values().next().value!);
    send({ type: 'platform-task-ack', eventId: event.eventId });
    publish();
  }
  async function poll() {
    if (!binding || state.authRequired || polling || bindingInFlight) return;
    polling = true;
    const owner = binding;
    try {
      if (!socket && !connecting) await connect();
      if (!state.connected || !connection) return;
      await reconcileRecovery();
      const tasks = z.array(platformTaskSchema).parse(await api('/user/tasks'));
      if (binding !== owner || state.authRequired) return;
      if (state.error.startsWith('浏览器连接暂不可用：')) state.error = '';
      const t = newerPlatformTask(
        state.task,
        tasks.find((t) => t.state !== 'closed') || tasks[0] || null,
      );
      state.task = t;
      if (t?.state === 'closed') {
        if (currentControl()) await release();
        await markRecovered();
      }
      if (t?.state === 'finalizing' && t.outcome === 'stopped') await cleanup(t);
      if (t?.state === 'running' && prepared?.taskId !== t.id && !state.busy) {
        await stopTask();
        state.error = '工作标签授权已失效，请在 OpenMAX 重新发起任务。';
      }
      await chrome.action.setBadgeText({
        text: t?.state === 'awaiting_consent' ? '!' : t?.state === 'waiting_user' ? '…' : '',
      });
      if (!socket && !connecting) await connect();
    } catch (e) {
      if (binding === owner && !state.authRequired)
        state.error = `浏览器连接暂不可用：${e instanceof Error ? e.message : 'NETWORK_ERROR'}`;
    } finally {
      polling = false;
      publish();
    }
  }
  async function connect() {
    if (!binding || state.authRequired || socket || connecting) return;
    connecting = true;
    const owner = binding;
    const epoch = generation;
    try {
      const ticket = z
        .object({ ticket: z.string(), url: z.literal('ws://127.0.0.1:18090/browser-control/ws') })
        .parse(await api('/user/ticket', {}));
      if (binding !== owner || epoch !== generation) return;
      const ws = new WebSocket(`${ticket.url}?ticket=${encodeURIComponent(ticket.ticket)}`);
      socket = ws;
      ws.onopen = () => {
        if (socket !== ws) return;
        // A WebSocket opening is not an authenticated account connection yet.
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        state.connected = false;
        connection = null;
        for (const pending of proofs.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('BROWSER_OFFLINE'));
        }
        proofs.clear();
        generation++;
        prepared = null;
        void release().then(markRecovered).finally(publish);
      };
      ws.onerror = () => {
        state.error = '浏览器控制连接失败，请检查本地 relay';
        publish();
      };
      ws.onmessage = (event) => {
        void receive(event.data, ws).catch((e) => {
          state.error = e instanceof Error ? e.message : 'INVALID_FRAME';
          publish();
        });
      };
    } finally {
      connecting = false;
    }
  }
  async function waitForRelay(validUntil: number) {
    const owner = binding;
    const epoch = generation;
    const deadline = Math.min(Date.now() + 5000, validUntil);
    // 只等待连接，不重发授权；慢握手不应消耗单次凭据或要求再打开 Popup。
    void connect().catch(() => {});
    while (true) {
      if (state.authRequired) throw new Error('DEVICE_AUTH_REQUIRED');
      if (!owner || binding !== owner || generation !== epoch) throw new Error('STALE_TASK');
      if (Date.now() >= deadline) throw new Error('BROWSER_NOT_READY');
      if (state.connected && socket?.readyState === WebSocket.OPEN) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async function receive(raw: string, ws: WebSocket) {
    if (socket !== ws) return;
    const m = z.object({ type: z.string() }).passthrough().parse(JSON.parse(raw));
    if (m.type === 'platform-ready') {
      const ready = z
        .object({
          protocol: z.literal(3),
          connection_id: z.string().uuid(),
          endpoint_id: z.string().uuid(),
          connection_epoch: z.string().uuid(),
          identity_id: z.string().uuid(),
        })
        .parse(m);
      if (ready.identity_id !== binding?.user.identity_id) throw new Error('ACCOUNT_MISMATCH');
      connection = {
        id: ready.connection_id,
        endpoint: ready.endpoint_id,
        epoch: ready.connection_epoch,
      };
      state.connected = true;
      state.error = '';
      sendState();
      publish();
      return;
    }
    if (m.type === 'browser-proof-result') {
      const id = z.string().parse(m.requestId);
      const pending = proofs.get(id);
      if (!pending) return;
      proofs.delete(id);
      clearTimeout(pending.timer);
      if (m.error) pending.reject(new Error(String(m.error)));
      else pending.resolve(m.data);
      return;
    }
    if (m.type === 'pong') return;
    if (m.type === 'platform-task') {
      eventQueue = eventQueue.catch(() => {}).then(() => applyTaskEvent(m));
      await eventQueue;
      return;
    }
    const t = state.task;
    const control = currentControl();
    if (
      !t ||
      !prepared ||
      prepared.taskId !== t.id ||
      prepared.activation !== t.activation_id ||
      prepared.session !== t.control_session_id ||
      m.platformTaskId !== t.id ||
      m.platformActivation !== t.activation_id ||
      m.platformEpoch !== connection?.epoch ||
      t.connection_epoch !== connection?.epoch ||
      Date.now() >= Date.parse(t.deadline) ||
      Date.now() >= Date.parse(t.absolute_deadline)
    )
      return;
    const frame = { ...m };
    delete frame.platformTaskId;
    delete frame.platformActivation;
    delete frame.platformEpoch;
    if (m.type === 'cancel') {
      await stopTask();
      return;
    }
    const id = z.string().parse(m.id);
    const resultType = m.type === 'command' || m.type === 'bootstrap' ? 'result' : 'cdp-response';
    if (inFlight.has(id) || processed.has(id) || inFlight.size >= 32) {
      send({ type: resultType, id, ok: false, error: { code: 'DUPLICATE_OR_BUSY' } });
      return;
    }
    if (t.state !== 'running' && !(t.state === 'finalizing' && m.type === 'command')) return;
    const version = generation;
    inFlight.add(id);
    try {
      let result: unknown;
      if (m.type === 'bootstrap') {
        const request = z
          .object({
            url: z.string().url(),
            deadline: z.number().int(),
          })
          .parse(m);
        const url = new URL(request.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new Error('INVALID_URL');
        const taskContext = prepared;
        if (taskContext.started || currentControl()) throw new Error('TASK_ALREADY_STARTED');
        if (taskContext.starting) throw new Error('BROWSER_BUSY');
        // 同步占用启动锁；不能在 source/storage/network await 之后才阻止并发 open。
        taskContext.starting = true;
        const assertStartable = (current: PlatformTask) => {
          if (
            prepared !== taskContext ||
            version !== generation ||
            socket !== ws ||
            current.state !== 'running' ||
            state.task?.state !== 'running'
          )
            throw new Error('STALE_TASK');
          if (
            request.deadline <= Date.now() ||
            Date.parse(current.deadline) <= Date.now() ||
            Date.parse(current.absolute_deadline) <= Date.now()
          )
            throw new Error('COMMAND_EXPIRED');
        };
        try {
          assertStartable(t);
          await sourceFor(t);
          journal[t.id] = {
            owner: binding!.user.identity_id,
            session: t.control_session_id,
            recovered: false,
          };
          await chrome.storage.local.set({ platformTaskJournal: journal });
          const reserved = await transitionFresh(
            t,
            'started',
            {
              control_session_id: t.control_session_id,
              operation_id: id,
            },
            assertStartable,
          );
          const source = await sourceFor(reserved);
          assertStartable(reserved);
          await attach(source.tabId, 'new', {
            url: request.url,
            taskId: t.control_session_id,
            windowId: source.windowId,
          });
          if (prepared !== taskContext || version !== generation) {
            await release();
            throw new Error('STALE_TASK');
          }
          taskContext.started = true;
        } catch (error) {
          // 建页失败/回执不确定时终止本次任务，不留下“已启动但无页面”的僵尸状态。
          if (prepared === taskContext && version === generation) {
            state.error = '工作页启动失败，本次任务已停止。请在对话中重新发起任务。';
            await stopTask().catch(() => {
              state.error = '工作页启动失败，已撤销本地控制；平台停止状态待同步。';
            });
            publish();
          }
          throw error;
        } finally {
          taskContext.starting = false;
        }
        sendState();
        result = { navigationRequested: true, next: 'Take a fresh snapshot and screenshot.' };
      } else if (m.type === 'cdp-command') result = await executeCdp(cdpRequestSchema.parse(frame));
      else if (m.type === 'cdp-bind') result = await bindCdp(cdpBindSchema.parse(frame));
      else if (m.type === 'command') {
        const command = commandSchema.parse(m.command);
        if (t.state === 'finalizing' && command.op !== 'finalize')
          throw new Error('TASK_FINALIZING');
        if (command.op === 'finalize' && prepared.starting) throw new Error('BROWSER_BUSY');
        if (command.op === 'finalize' && !prepared.started && !control) {
          if (
            command.taskId !== prepared.session ||
            command.keep.length ||
            z.number().parse(m.deadline) <= Date.now()
          )
            throw new Error('INVALID_FINALIZE');
          result = { closed: [], retained: [], controlReleased: true };
        } else result = await execute(command, z.number().parse(m.deadline));
      } else return;
      if (version === generation && socket === ws) send({ type: resultType, id, ok: true, result });
    } catch (e) {
      if (socket === ws)
        send({
          type: resultType,
          id,
          ok: false,
          error: browserOperationError(e),
        });
    } finally {
      inFlight.delete(id);
      processed.add(id);
      if (processed.size > 500) processed.delete(processed.values().next().value!);
    }
  }
  onState(sendState);
  onCdpEvent((event) => send(z.record(z.unknown()).parse(event)));
  async function confirmBinding(raw: unknown, sender: chrome.runtime.MessageSender) {
    const m = bindingConfirmationSchema.parse(raw);
    if (!bindingCallbackAllowed(sender, m.nonce, m.nonce, await currentSenderTab(sender)))
      throw new Error('INVALID_BINDING_CALLBACK');
    const fingerprint = await digest(JSON.stringify(m));
    const receipt = binding?.confirmation;
    // 保存凭据和回执为同一条记录；丢失 ACK 或 worker 重启后不再次兑换。
    if (
      !state.authRequired &&
      receipt &&
      receipt.expires > Date.now() &&
      receipt.tabId === sender.tab!.id &&
      receipt.nonce === m.nonce &&
      receipt.fingerprint === fingerprint
    )
      return { ok: true, status: 'bound', connected: state.connected };
    const pending = login;
    if (
      !pending ||
      pending.expires <= Date.now() ||
      pending.nonce !== m.nonce ||
      pending.tabId !== sender.tab!.id
    )
      throw new Error('INVALID_BINDING_CALLBACK');
    if (bindingInFlight) {
      if (bindingInFlight.fingerprint === fingerprint) return bindingInFlight.promise;
      throw new Error('BROWSER_BUSY');
    }
    if (state.busy || (state.task && state.task.state !== 'closed'))
      throw new Error('BROWSER_BUSY');
    if (pending.redeeming) throw new Error('BINDING_RESTART_REQUIRED');
    state.busy = true;
    state.error = '';
    publish();
    const promise = (async () => {
      try {
        if (login !== pending || pending.expires <= Date.now())
          throw new Error('INVALID_BINDING_CALLBACK');
        await stopTask();
        const old = socket;
        socket = null;
        connection = null;
        state.connected = false;
        old?.close();
        // 不确定兑换结果时禁止自动重放。旧版待确认数据也不能被解释为用户已确认。
        pending.redeeming = true;
        await chrome.storage.session.set({ platformLogin: pending });
        const next = bindingSchema.parse(
          await api('/local-login/redeem', {
            code: m.code,
            verifier: pending.verifier,
            nonce: pending.nonce,
          }),
        );
        next.confirmation = {
          fingerprint,
          nonce: pending.nonce,
          tabId: pending.tabId!,
          expires: pending.expires,
        };
        await chrome.storage.local.set({ platformUserSession: next });
        binding = next;
        state.authRequired = false;
        login = null;
        state.user = next.user;
        state.loginPending = false;
        state.task = null;
        await chrome.storage.session.remove('platformLogin').catch(() => {});
        // 绑定成功与 relay 在线分开，网络故障由既有后台重连处理。
        await connect().catch(() => {
          if (!state.authRequired) state.error = '绑定已完成，控制连接暂不可用，后台会自动重连。';
        });
        return { ok: true, status: 'bound', connected: state.connected };
      } catch (error) {
        state.error = '连接未完成，请从插件重新发起登录连接。';
        if (pending.redeeming) {
          login = null;
          state.loginPending = false;
          await chrome.storage.session.remove('platformLogin').catch(() => {});
        }
        throw error;
      } finally {
        bindingInFlight = null;
        state.busy = false;
        publish();
      }
    })();
    bindingInFlight = { fingerprint, promise };
    return promise;
  }
  async function beginBinding(tabId?: number) {
    if (bindingInFlight || (state.task && state.task.state !== 'closed'))
      throw new Error('BROWSER_BUSY');
    const next = {
      version: 3 as const,
      verifier: random(),
      nonce: random(),
      expires: Date.now() + 10 * 60 * 1000,
      tabId,
    };
    login = next;
    const params = {
      extension_id: chrome.runtime.id,
      challenge: await digest(next.verifier),
      nonce: next.nonce,
    };
    if (tabId === undefined) {
      const url = new URL(platformWeb + '/account');
      url.searchParams.set('browser_login', '1');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const tab = await chrome.tabs.create({ url: url.href });
      if (tab.id === undefined) throw new Error('TAB_UNAVAILABLE');
      next.tabId = tab.id;
    }
    await chrome.storage.session.set({ platformLogin: next });
    state.loginPending = true;
    publish();
    return params; // Public handshake only; verifier/device credential never leaves background.
  }
  const boot = (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await recoverTasks();
    const savedJournal = await chrome.storage.local.get('platformTaskJournal');
    const parsedJournal = journalSchema.safeParse(savedJournal.platformTaskJournal);
    journal = parsedJournal.success ? parsedJournal.data : {};
    if (!cleanupWarning()) {
      for (const record of Object.values(journal)) record.recovered = true;
      await chrome.storage.local.set({ platformTaskJournal: journal });
    }
    const saved = await chrome.storage.local.get('platformUserSession');
    const parsed = bindingSchema.safeParse(saved.platformUserSession);
    binding = parsed.success ? parsed.data : null;
    state.user = binding?.user || null;
    const pending = await chrome.storage.session.get('platformLogin');
    const p = loginSchema.safeParse(pending.platformLogin);
    login = p.success && p.data.expires > Date.now() && !p.data.redeeming ? p.data : null;
    state.loginPending = !!login;
    if (pending.platformLogin && !login) {
      await chrome.storage.session.remove('platformLogin');
      if (!binding) state.error = '登录确认已过期或中断，请重新登录连接。';
    }
    await poll();
    publish();
  })();
  void boot.catch(() => {
    state.error = '插件初始化失败，请重新加载';
    publish();
  });
  setInterval(() => {
    send({ type: 'ping' });
    void poll();
  }, 2000);
  chrome.alarms.create('platform-reconnect', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(() => void poll());
  chrome.runtime.onMessageExternal.addListener((raw, sender, reply) => {
    // 早于网页 20 秒回执超时停止启动新动作，避免迟到的授权仍创建工作页。
    const actionDeadline = Date.now() + 18000;
    void (async () => {
      await boot;
      if (
        z
          .object({ type: z.literal('browser-binding-start') })
          .strict()
          .safeParse(raw).success
      ) {
        if (
          !bindingCallbackAllowed(
            sender,
            'source-check',
            'source-check',
            await currentSenderTab(sender),
          )
        )
          throw new Error('INVALID_BINDING_CALLBACK');
        if (state.busy) throw new Error('BROWSER_BUSY');
        state.busy = true;
        try {
          return { ok: true, params: await beginBinding(sender.tab!.id!) };
        } finally {
          state.busy = false;
          publish();
        }
      }
      const probe = deviceProbeSchema.safeParse(raw);
      const pageState = z
        .object({
          type: z.literal('browser-task-page-state'),
          taskId: z.string().uuid(),
          endpointId: z.string().uuid(),
          connectionEpoch: z.string().uuid(),
        })
        .strict()
        .safeParse(raw);
      if (pageState.success) {
        await requireChatSource(sender);
        const m = pageState.data;
        // 仅提供同一任务的展示状态，不签发证明、不改变授权或启动页面。
        const hasWorkTab = !!(
          binding &&
          !state.authRequired &&
          state.connected &&
          state.task?.id === m.taskId &&
          state.task.endpoint_id === m.endpointId &&
          state.task.connection_epoch === m.connectionEpoch &&
          connection?.endpoint === m.endpointId &&
          connection.epoch === m.connectionEpoch &&
          snapshotState().hasWorkTab
        );
        return {
          ok: true,
          taskId: m.taskId,
          endpointId: m.endpointId,
          connectionEpoch: m.connectionEpoch,
          hasWorkTab,
        };
      }
      if (probe.success) {
        if (bindingInFlight || state.busy) throw new Error('BROWSER_BUSY');
        if (state.authRequired || !binding) throw new Error('DEVICE_AUTH_REQUIRED');
        const owner = binding;
        const epoch = generation;
        const initialTab = await requireChatSource(sender);
        await waitForRelay(actionDeadline);
        const tab = await requireChatSource(sender);
        if (tab.windowId !== initialTab.windowId) throw new Error('INVALID_CHAT_SOURCE');
        for (const [key, value] of sources) if (value.expires <= Date.now()) sources.delete(key);
        if (sources.size >= 32) throw new Error('BROWSER_BUSY');
        const sourceId = crypto.randomUUID();
        const source = {
          taskId: probe.data.taskId,
          tabId: tab.id!,
          windowId: tab.windowId,
          expires: Date.now() + 120000,
        };
        const proof = deviceProofSchema.parse(
          await new Promise<unknown>((resolve, reject) => {
            const requestId = crypto.randomUUID();
            const timer = setTimeout(() => {
              proofs.delete(requestId);
              reject(new Error('PROOF_TIMEOUT'));
            }, 5000);
            proofs.set(requestId, { resolve, reject, timer });
            send({
              type: 'browser-proof-request',
              requestId,
              task_id: probe.data.taskId,
              revision: probe.data.revision,
              source_id: sourceId,
              nonce: random(),
            });
          }),
        );
        // A navigation or tab close while waiting for the relay must not issue a
        // proof for a page that is no longer an eligible OpenMAX chat.
        const finalTab = await requireChatSource(sender);
        if (finalTab.windowId !== source.windowId) throw new Error('INVALID_CHAT_SOURCE');
        if (binding !== owner || generation !== epoch) throw new Error('STALE_TASK');
        sources.set(sourceId, source);
        // Only a proof is returned. The webpage cannot start a task locally.
        return { ok: true, ...proof };
      }
      return confirmBinding(raw, sender);
    })().then(reply, (e) =>
      reply({ ok: false, error: e instanceof Error ? e.message : 'BROWSER_ERROR' }),
    );
    return true;
  });
  chrome.runtime.onMessage.addListener((raw, sender, reply) => {
    if (!isPanelSender(sender)) return false;
    const parsed = platformRequestSchema.safeParse(raw);
    if (!parsed.success) return false;
    void (async () => {
      await boot;
      const m = parsed.data;
      if (m.type === 'platform-state') return snapshotState();
      if (m.type === 'platform-reveal') {
        if (!snapshotState().hasWorkTab)
          throw new Error('工作页尚未创建，请等待 Agent 打开目标网站。');
        await revealTask();
        return snapshotState();
      }
      if (bindingInFlight || (state.busy && !(m.type === 'platform-decide' && m.action === 'stop')))
        throw new Error('操作处理中');
      state.busy = true;
      state.error = '';
      publish();
      try {
        if (m.type === 'platform-login') {
          await beginBinding();
        } else if (m.type === 'platform-disconnect') {
          login = null;
          state.loginPending = false;
          await chrome.storage.session.remove('platformLogin');
          try {
            await stopTask();
            if (!state.authRequired) await api('/local-login/logout', {});
          } catch (e) {
            // 包括停止旧任务时才发现撤销；网络/服务故障不能冒充撤销成功。
            if (!(
              e instanceof PlatformApiError &&
              e.status === 401 &&
              e.code === 'DEVICE_AUTH_REQUIRED'
            ))
              throw e;
          }
          const old = socket;
          socket = null;
          connection = null;
          state.connected = false;
          old?.close();
          await chrome.storage.local.remove('platformUserSession');
          binding = null;
          state.authRequired = false;
          state.error = '';
          state.user = null;
          state.task = null;
          await chrome.action.setBadgeText({ text: '' });
        } else if (m.type === 'platform-decide') {
          if (state.task?.id !== m.taskId) throw new Error('STALE_TASK');
          await stopTask();
        }
      } finally {
        state.busy = false;
        publish();
      }
      return state;
    })().then(
      (value) => reply({ ok: true, value }),
      (e) => {
        if (!state.authRequired) state.error = e instanceof Error ? e.message : '操作失败';
        publish();
        reply({ ok: false, error: state.error });
      },
    );
    return true;
  });
}
