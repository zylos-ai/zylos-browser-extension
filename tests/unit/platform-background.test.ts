// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const executor = vi.hoisted(() => ({
  attach: vi.fn(),
  release: vi.fn(),
  currentControl: vi.fn((): null | { sessionId: string; tabIds: number[] } => null),
  currentGrant: vi.fn(() => null),
  execute: vi.fn(),
  onState: vi.fn(),
  initializeExecutor: vi.fn(),
  bindCdp: vi.fn(),
  executeCdp: vi.fn(),
  onCdpEvent: vi.fn(),
  revealTask: vi.fn(),
}));
vi.mock('../../utils/automation/executor', () => executor);
vi.mock('../../utils/automation/task-lifecycle', () => ({
  recoverTasks: vi.fn(),
  cleanupWarning: () => '',
}));
vi.mock('../../utils/messages', () => ({ isPanelSender: () => true }));
import { startPlatformBackground } from '../../entrypoints/background/platform';
const id = '11111111-1111-4111-8111-111111111111';
const user = { identity_id: id, display_name: 'Browser' };
type Handler = (m: unknown, s: unknown, r: (v: unknown) => void) => boolean;
let external: Handler,
  internal: Handler,
  active: Socket,
  task: Record<string, unknown>,
  sourceId: string;
let posts: { path: string; body: Record<string, unknown> }[];
let proofError = '',
  delay = 0;
class Socket {
  static OPEN = 1;
  readyState = 0;
  frames: Record<string, unknown>[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() {
    active = this;
    setTimeout(() => {
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.onopen?.();
      this.receive({
        type: 'platform-ready',
        protocol: 3,
        connection_id: id,
        endpoint_id: id,
        connection_epoch: id,
        identity_id: id,
      });
    }, delay);
  }
  send(raw: string) {
    const m = JSON.parse(raw);
    this.frames.push(m);
    if (m.type === 'browser-proof-request') {
      sourceId = m.source_id;
      this.receive({
        type: 'browser-proof-result',
        requestId: m.requestId,
        ...(proofError
          ? { error: proofError }
          : {
              data: {
                browser_proof: 'p'.repeat(100),
                endpoint_id: id,
                connection_epoch: id,
                expires_at: new Date(Date.now() + 30000).toISOString(),
              },
            }),
      });
    }
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  delay = 0;
  proofError = '';
  sourceId = '';
  posts = [];
  executor.currentControl.mockReturnValue(null);
  executor.attach.mockImplementation(async () => {
    executor.currentControl.mockReturnValue({ sessionId: id, tabIds: [999] });
  });
  executor.release.mockImplementation(async () => {
    executor.currentControl.mockReturnValue(null);
  });
  task = {
    id,
    owner_identity_id: id,
    connection_epoch: id,
    endpoint_id: '',
    source_id: '',
    state: 'awaiting_consent',
    revision: '1',
    activation_id: id,
    control_session_id: '',
    deadline: new Date(Date.now() + 60000).toISOString(),
    absolute_deadline: new Date(Date.now() + 1800000).toISOString(),
    outcome: '',
    cleanup_state: 'not_required',
  };
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'a'.repeat(32),
      sendMessage: vi.fn(async () => {}),
      onMessageExternal: {
        addListener: (h: Handler) => {
          external = h;
        },
      },
      onMessage: {
        addListener: (h: Handler) => {
          internal = h;
        },
      },
    },
    storage: {
      local: {
        setAccessLevel: vi.fn(),
        get: async () => ({
          platformUserSession: {
            access_token: 'user-session',
            user,
            mode: 'local-development',
            expires_at: new Date(Date.now() + 900000).toISOString(),
          },
        }),
        set: vi.fn(async () => {}),
      },
      session: { get: async () => ({}) },
    },
    action: { setBadgeText: vi.fn() },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn(),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        windowId: 8,
        index: 2,
        url: 'http://localhost:3000/workspace',
        incognito: false,
      })),
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname.replace('/api/v1/browser', '');
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (init.method === 'POST') posts.push({ path, body });
      let data: unknown;
      if (path === '/user/tasks') data = task.endpoint_id ? [task] : [];
      else if (path === '/user/ticket')
        data = { ticket: 'ws-code', url: 'ws://127.0.0.1:18090/browser-control/ws' };
      else if (path === '/device/proof') {
        if (proofError)
          return new Response(JSON.stringify({ error: { code: proofError } }), { status: 403 });
        sourceId = String(body.source_id);
        data = {
          browser_proof: 'p'.repeat(100),
          endpoint_id: id,
          expires_at: new Date(Date.now() + 30000).toISOString(),
        };
      } else if (path === '/tasks/' + id) data = task;
      else if (path === '/tasks/' + id + '/ready') {
        expect(task.state).toBe('preparing');
        expect(body.control_session_id).toBe(id);
        task = { ...task, state: 'running', revision: String(Number(task.revision) + 1) };
        data = task;
      } else if (path === '/tasks/' + id + '/started') {
        if (body.revision !== task.revision)
          return new Response(JSON.stringify({ error: { code: 'STALE_TASK' } }), { status: 409 });
        expect(task.state).toBe('running');
        task = { ...task, cleanup_state: 'pending', revision: String(Number(task.revision) + 1) };
        data = task;
      } else if (path === '/tasks/' + id + '/stop') {
        if (body.revision !== task.revision)
          return new Response(JSON.stringify({ error: { code: 'STALE_TASK' } }), { status: 409 });
        task = {
          ...task,
          state: task.control_session_id ? 'finalizing' : 'closed',
          outcome: 'stopped',
          revision: String(Number(task.revision) + 1),
        };
        data = task;
      } else if (path === '/tasks/' + id + '/cleanup') {
        expect(body.revision).toBe(task.revision);
        expect(task.state).toBe('finalizing');
        task = {
          ...task,
          state: 'closed',
          cleanup_state: body.cleanup_state,
          revision: String(Number(task.revision) + 1),
        };
        data = task;
      } else throw Error('Unexpected request ' + path);
      return new Response(JSON.stringify({ data }));
    }),
  );
  startPlatformBackground();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const sender = {
  url: 'http://localhost:3000/workspace',
  frameId: 0,
  tab: { id: 7, windowId: 8, incognito: false },
};
async function boot() {
  await vi.advanceTimersByTimeAsync(20);
  return new Promise<unknown>((r) => internal({ type: 'platform-state' }, {}, r));
}
async function probe(change: unknown = sender) {
  await boot();
  const p = new Promise<unknown>((r) =>
    external({ type: 'browser-device-probe', taskId: id, revision: '1' }, change, r),
  );
  await vi.advanceTimersByTimeAsync(20);
  return p;
}
async function prepare() {
  await probe();
  task = {
    ...task,
    endpoint_id: id,
    source_id: sourceId,
    state: 'preparing',
    revision: '2',
    control_session_id: id,
  };
  active.receive({ type: 'platform-task', eventId: '1', task });
  await vi.advanceTimersByTimeAsync(20);
}
function bootstrap(
  operation = '22222222-2222-4222-8222-222222222222',
  url = 'https://example.com',
) {
  active.receive({
    type: 'bootstrap',
    id: operation,
    url,
    deadline: Date.now() + 10000,
    platformTaskId: id,
    platformActivation: id,
    platformEpoch: id,
  });
}
describe('平台中转任务生命周期', () => {
  it('网页只读页面状态不授权、不建页，必须匹配任务和连接代次', async () => {
    await prepare();
    const read = (change = {}, from = sender) =>
      new Promise((r) =>
        external(
          {
            type: 'browser-task-page-state',
            taskId: id,
            endpointId: id,
            connectionEpoch: id,
            ...change,
          },
          from,
          r,
        ),
      );
    expect(await read()).toEqual({
      ok: true,
      taskId: id,
      endpointId: id,
      connectionEpoch: id,
      hasWorkTab: false,
    });
    expect(executor.attach).not.toHaveBeenCalled();
    const proofCount = active.frames.filter((m) => m.type === 'browser-proof-request').length;
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(await read()).toMatchObject({ hasWorkTab: true });
    expect(await read({ taskId: crypto.randomUUID() })).toMatchObject({ hasWorkTab: false });
    expect(await read({ connectionEpoch: crypto.randomUUID() })).toMatchObject({
      hasWorkTab: false,
    });
    expect(await read({}, { ...sender, frameId: 1 })).toMatchObject({
      ok: false,
      error: 'INVALID_CHAT_SOURCE',
    });
    expect(active.frames.filter((m) => m.type === 'browser-proof-request')).toHaveLength(
      proofCount,
    );
    expect(executor.attach).toHaveBeenCalledTimes(1);
  });
  it('Channel touch 已提交但中转通知未到时，首次打开仍创建且只创建一个工作页', async () => {
    await prepare();
    task = { ...task, revision: '4' };
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).toHaveBeenCalledTimes(1);
    expect(active.frames).toContainEqual(expect.objectContaining({ type: 'result', ok: true }));
    expect(posts.filter((p) => p.path.endsWith('/started')).at(-1)?.body.revision).toBe('4');
  });
  it('读取后再次遇到明确版本冲突会重新核对任务，而不是重放建页', async () => {
    await prepare();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let raced = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/started') && !raced) {
        raced = true;
        task = { ...task, revision: String(Number(task.revision) + 1) };
      }
      return original(url, init);
    });
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).toHaveBeenCalledTimes(1);
    expect(posts.filter((p) => p.path.endsWith('/started')).map((p) => p.body.revision)).toEqual([
      '3',
      '4',
    ]);
  });
  it.each(['activation_id', 'control_session_id', 'connection_epoch'])(
    '权威 %s 已变化时拒绝旧启动',
    async (field) => {
      await prepare();
      task = { ...task, [field]: crypto.randomUUID(), revision: '4' };
      bootstrap();
      await vi.advanceTimersByTimeAsync(20);
      expect(executor.attach).not.toHaveBeenCalled();
      expect(posts.filter((p) => p.path.endsWith('/started'))).toHaveLength(0);
      expect(active.frames).toContainEqual(expect.objectContaining({ type: 'result', ok: false }));
    },
  );
  it('两个不同命令并发启动只提交一次建页', async () => {
    await prepare();
    bootstrap();
    bootstrap(crypto.randomUUID());
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).toHaveBeenCalledTimes(1);
    expect(posts.filter((p) => p.path.endsWith('/started'))).toHaveLength(1);
  });
  it('持续版本冲突有上限并停止任务，不留无限启动状态', async () => {
    await prepare();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/started'))
        task = { ...task, revision: String(Number(task.revision) + 1) };
      return original(url, init);
    });
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(posts.filter((p) => p.path.endsWith('/started'))).toHaveLength(3);
    expect(executor.attach).not.toHaveBeenCalled();
    expect(task.state).toBe('closed');
  });
  it('started 回执丢失不重发、不建页，撤销本地控制并停止任务', async () => {
    await prepare();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (String(url).endsWith('/started')) throw new Error('response lost');
      return result;
    });
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(posts.filter((p) => p.path.endsWith('/started'))).toHaveLength(1);
    expect(executor.attach).not.toHaveBeenCalled();
    expect(task.state).toBe('closed');
    expect(await boot()).toMatchObject({ ok: true, value: { hasWorkTab: false } });
  });
  it('Chrome 建页失败后停止任务，迟到 open 不得重新启动', async () => {
    await prepare();
    executor.attach.mockRejectedValueOnce(new Error('Chrome create failed'));
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(task.state).toBe('closed');
    bootstrap(crypto.randomUUID());
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).toHaveBeenCalledTimes(1);
    expect(executor.release).toHaveBeenCalled();
  });
  it('等待 started 回执时断线，迟到成功不能创建页面', async () => {
    await prepare();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (String(url).endsWith('/started')) active.close();
      return result;
    });
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).not.toHaveBeenCalled();
    expect(await boot()).toMatchObject({
      ok: true,
      value: { hasWorkTab: false, connected: false },
    });
  });
  it('等待启动校验时用户停止，平台回执迟到不能再次建页', async () => {
    await prepare();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let stopped = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (String(url).endsWith('/started') && !stopped) {
        stopped = true;
        const reply = await new Promise((r) =>
          internal({ type: 'platform-decide', taskId: id, action: 'stop' }, {}, r),
        );
        expect(reply).toMatchObject({ ok: true });
      }
      return result;
    });
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(task.state).toBe('closed');
    expect(task.cleanup_state).toBe('confirmed');
    expect(executor.attach).not.toHaveBeenCalled();
  });
  it('只有当前任务的实际标签存在才发布 hasWorkTab，尚未建页时不能 reveal', async () => {
    await prepare();
    expect(await boot()).toMatchObject({ ok: true, value: { hasWorkTab: false } });
    const beforeOpen = await new Promise((r) => internal({ type: 'platform-reveal' }, {}, r));
    expect(beforeOpen).toMatchObject({ ok: false });
    expect(executor.revealTask).not.toHaveBeenCalled();
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(await boot()).toMatchObject({ ok: true, value: { hasWorkTab: true } });
    const onChange = executor.onState.mock.calls[0]![0] as () => void;
    executor.currentControl.mockReturnValue(null);
    onChange();
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'platform-updated',
        state: expect.objectContaining({ hasWorkTab: false }),
      }),
    );
    executor.currentControl.mockReturnValue({ sessionId: 'another-task', tabIds: [999] });
    expect(await boot()).toMatchObject({ ok: true, value: { hasWorkTab: false } });
  });
  it('登录页通过 SPA 返回聊天后可以取得证明，无需刷新或打开 Popup', async () => {
    expect(
      await probe({ ...sender, url: 'http://localhost:3000/workspace/account' }),
    ).toMatchObject({ ok: true, browser_proof: 'p'.repeat(100) });
    expect(executor.attach).not.toHaveBeenCalled();
    expect(posts.some((p) => p.path.endsWith('/ready'))).toBe(false);
  });
  it.each([
    { frameId: 1 },
    { frameId: undefined },
    { tab: undefined },
    { tab: { ...sender.tab, incognito: true } },
    { url: 'https://evil.test/workspace' },
    { origin: 'null' },
  ])('不能用合法的当前页面冒充可信消息来源：%j', async (change) => {
    expect(await probe({ ...sender, ...change })).toMatchObject({
      ok: false,
      error: 'INVALID_CHAT_SOURCE',
    });
    expect(active.frames.some((m) => m.type === 'browser-proof-request')).toBe(false);
  });
  it('当前页面已不是聊天时拒绝，即使消息携带旧聊天地址', async () => {
    vi.mocked(chrome.tabs.get).mockImplementation(
      async () =>
        ({
          ...sender.tab,
          url: 'http://localhost:3000/workspace/account',
        }) as chrome.tabs.Tab,
    );
    expect(await probe()).toMatchObject({ ok: false, error: 'INVALID_CHAT_SOURCE' });
    expect(active.frames.some((m) => m.type === 'browser-proof-request')).toBe(false);
  });
  it('消息来源标签已经关闭时拒绝，不发证明', async () => {
    vi.mocked(chrome.tabs.get).mockRejectedValue(new Error('No tab with id: 7'));
    expect(await probe()).toMatchObject({ ok: false, error: 'INVALID_CHAT_SOURCE' });
    expect(active.frames.some((m) => m.type === 'browser-proof-request')).toBe(false);
  });
  it.each([2, 3])('等待中转时重新校验页面，第 %i 次检查发现跳转就拒绝', async (changedAt) => {
    let reads = 0;
    vi.mocked(chrome.tabs.get).mockImplementation(
      async () =>
        ({
          ...sender.tab,
          url: ++reads < changedAt ? sender.url : 'http://localhost:3000/workspace/account',
        }) as chrome.tabs.Tab,
    );
    expect(await probe()).toMatchObject({ ok: false, error: 'INVALID_CHAT_SOURCE' });
    expect(executor.attach).not.toHaveBeenCalled();
  });
  it('读取当前设备证明不等于授权，不创建页面或调用 ready', async () => {
    expect(await probe()).toMatchObject({
      ok: true,
      browser_proof: 'p'.repeat(100),
      endpoint_id: id,
    });
    expect(executor.attach).not.toHaveBeenCalled();
    expect(executor.bindCdp).not.toHaveBeenCalled();
    expect(posts.map((p) => p.path)).toEqual(['/user/ticket']);
    expect(active.frames.find((m) => m.type === 'browser-proof-request')).toMatchObject({
      task_id: id,
      revision: '1',
      source_id: sourceId,
    });
  });
  it('平台准备事件只接受上下文，首次 open 才创建目标 URL 页面', async () => {
    await prepare();
    expect(task.state).toBe('running');
    expect(executor.attach).not.toHaveBeenCalled();
    expect(posts.filter((p) => p.path.endsWith('/ready'))).toHaveLength(1);
    expect(active.frames).toContainEqual(
      expect.objectContaining({ type: 'state', control: null, preparedSession: id }),
    );
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).toHaveBeenCalledExactlyOnceWith(7, 'new', {
      url: 'https://example.com',
      taskId: id,
      windowId: 8,
    });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(active.frames).toContainEqual(expect.objectContaining({ type: 'result', ok: true }));
  });
  it('就绪后尚未打开任何页面，也能确认收尾而不删除用户页', async () => {
    await prepare();
    task = { ...task, state: 'finalizing', revision: '4' };
    active.receive({ type: 'platform-task', eventId: '2', task });
    await vi.advanceTimersByTimeAsync(20);
    active.receive({
      type: 'command',
      id: 'close-empty',
      command: { op: 'finalize', taskId: id, keep: [] },
      deadline: Date.now() + 10000,
      platformTaskId: id,
      platformActivation: id,
      platformEpoch: id,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.attach).not.toHaveBeenCalled();
    expect(active.frames).toContainEqual(
      expect.objectContaining({
        type: 'result',
        id: 'close-empty',
        ok: true,
        result: { closed: [], retained: [], controlReleased: true },
      }),
    );
  });
  it('准备事件重复投递、重复启动都不创建第二个页面', async () => {
    await prepare();
    active.receive({ type: 'platform-task', eventId: '1', task });
    await vi.advanceTimersByTimeAsync(20);
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).toHaveBeenCalledTimes(1);
    expect(posts.filter((p) => p.path.endsWith('/ready'))).toHaveLength(1);
  });
  it('未经平台允许的 bootstrap 和 CDP 没有作用', async () => {
    await probe();
    bootstrap();
    active.receive({ type: 'cdp-command', id: 'x', platformTaskId: id, platformActivation: id });
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).not.toHaveBeenCalled();
    expect(executor.executeCdp).not.toHaveBeenCalled();
  });
  it('来源窗口改变时拒绝创建，不回退当前焦点页', async () => {
    await prepare();
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 7,
      windowId: 9,
      url: 'http://localhost:3000/workspace',
    } as chrome.tabs.Tab);
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).not.toHaveBeenCalled();
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(active.frames).toContainEqual(expect.objectContaining({ type: 'result', ok: false }));
  });
  it('过期或错误激活的命令不执行', async () => {
    await prepare();
    active.receive({
      type: 'bootstrap',
      id: 'x',
      url: 'https://example.com',
      deadline: Date.now() + 10000,
      platformTaskId: id,
      platformActivation: 'old',
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).not.toHaveBeenCalled();
    task = { ...task, deadline: new Date(Date.now() - 1).toISOString() };
    active.receive({ type: 'platform-task', eventId: '2', task });
    await vi.advanceTimersByTimeAsync(20);
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.attach).not.toHaveBeenCalled();
  });
  it('断线立即撤销本地控制，迟到命令不能重启', async () => {
    await prepare();
    active.close();
    bootstrap();
    await vi.advanceTimersByTimeAsync(20);
    expect(executor.release).toHaveBeenCalled();
    expect(executor.attach).not.toHaveBeenCalled();
  });
  it('旧网页执行消息和 Popup 授权入口均不再可用', async () => {
    await boot();
    const result = await new Promise<unknown>((r) =>
      external(
        { type: 'browser-task-action', taskId: id, action: 'approve', code: 'c'.repeat(43) },
        sender,
        r,
      ),
    );
    expect(result).toMatchObject({ ok: false });
    expect(internal({ type: 'platform-decide', taskId: id, action: 'approve' }, {}, vi.fn())).toBe(
      false,
    );
    expect(executor.attach).not.toHaveBeenCalled();
  });
  it.each([
    { ...sender, frameId: 1 },
    { ...sender, url: 'https://evil.test/workspace' },
    { ...sender, tab: { id: 7, incognito: true } },
  ])('不可信网页不能探测设备 %#', async (s) => {
    expect(await probe(s)).toMatchObject({ ok: false });
    expect(posts.map((p) => p.path)).not.toContain('/device/proof');
  });
  it('账号不匹配证明错误不转成成功', async () => {
    proofError = 'CURRENT_BROWSER_MISMATCH';
    expect(await probe()).toEqual({ ok: false, error: 'CURRENT_BROWSER_MISMATCH' });
    expect(executor.attach).not.toHaveBeenCalled();
  });
});
