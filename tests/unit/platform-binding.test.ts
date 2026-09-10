// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executor = vi.hoisted(() => ({
  initializeExecutor: vi.fn(),
  attach: vi.fn(),
  release: vi.fn(async () => {}),
  execute: vi.fn(),
  currentControl: vi.fn(() => null),
  currentGrant: vi.fn(() => null),
  onState: vi.fn(),
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
import { platformStateSchema } from '../../utils/platform';

const id = '11111111-1111-4111-8111-111111111111';
const user = { identity_id: id, display_name: 'Test Browser' };
const credentials = (access_token = 'test-user-session') => ({
  access_token,
  user,
  mode: 'local-development',
  expires_at: new Date(Date.now() + 900000).toISOString(),
});
const request = {
  type: 'browser-user-login-confirm',
  code: 'c'.repeat(43),
  nonce: 'n'.repeat(43),
};
const sender = {
  url: 'http://localhost:3000/workspace/account',
  frameId: 0,
  tab: { id: 7, incognito: false },
};
type Handler = (m: unknown, s: unknown, r: (v: unknown) => void) => boolean;
let external: Handler;
let internal: Handler;
let local: Record<string, unknown>;
let session: Record<string, unknown>;
let paths: string[];
let preview: () => Promise<unknown>;
let redeem: () => Promise<unknown>;
let connectFails: boolean;
let apiFaults: Record<string, { status: number; code: string }>;
let deviceTasks: unknown[];
class Socket {
  static instances: Socket[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor() {
    Socket.instances.push(this);
    queueMicrotask(() => {
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({
          type: 'platform-ready',
          protocol: 3,
          connection_id: id,
          endpoint_id: id,
          connection_epoch: id,
          identity_id: id,
        }),
      });
    });
  }
  close = vi.fn();
  send() {}
}
function storageArea(data: Record<string, unknown>) {
  return {
    get: vi.fn(async () => structuredClone(data)),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(data, structuredClone(values));
    }),
    remove: vi.fn(async (key: string) => {
      delete data[key];
    }),
    setAccessLevel: vi.fn(),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  local = {};
  session = {
    platformLogin: {
      version: 3,
      verifier: 'v'.repeat(43),
      nonce: request.nonce,
      tabId: 7,
      expires: Date.now() + 600000,
    },
  };
  paths = [];
  connectFails = false;
  apiFaults = {};
  deviceTasks = [];
  Socket.instances = [];
  preview = async () => ({ agent_member_id: id });
  redeem = async () => credentials();
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
    storage: { local: storageArea(local), session: storageArea(session) },
    action: { setBadgeText: vi.fn() },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    tabs: {
      create: vi.fn(async () => ({ id: 7 })),
      get: vi.fn(async (id: number) => ({ id, url: sender.url, incognito: false })),
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname.replace('/api/v1/browser', '');
      paths.push(path);
      const fault = apiFaults[path];
      if (fault)
        return new Response(JSON.stringify({ error: { code: fault.code } }), {
          status: fault.status,
        });
      let data: unknown;
      if (path === '/local-login/redeem') {
        expect(JSON.parse(String(init.body))).toEqual({
          code: request.code,
          verifier: 'v'.repeat(43),
          nonce: request.nonce,
        });
        data = await redeem();
      } else if (path === '/user/tasks') data = deviceTasks;
      else if (path === `/tasks/${id}`) data = deviceTasks[0];
      else if (path === '/user/ticket') {
        if (connectFails) throw new Error('NETWORK_ERROR');
        data = { ticket: 'test-ticket', url: 'ws://127.0.0.1:18090/browser-control/ws' };
      } else throw new Error(`Unexpected request ${path}`);
      return new Response(JSON.stringify({ data }));
    }),
  );
});

describe('失效设备的恢复入口', () => {
  const saved = () => credentials('old-user-session');
  const internalMessage = (m: unknown) => new Promise((resolve) => internal(m, {}, resolve));
  it('插件登录打开个人主页，只携带公开握手参数，不选择 Agent', async () => {
    await boot();
    expect(await internalMessage({ type: 'platform-login' })).toMatchObject({ ok: true });
    const created = vi.mocked(chrome.tabs.create).mock.calls[0]?.[0];
    if (!created?.url) throw new Error('Expected a login tab');
    const url = new URL(created.url);
    expect(url.origin + url.pathname).toBe('http://localhost:3000/workspace/account');
    expect(Object.keys(Object.fromEntries(url.searchParams)).sort()).toEqual(
      ['browser_login', 'extension_id', 'challenge', 'nonce'].sort(),
    );
    expect(url.searchParams.get('browser_login')).toBe('1');
    expect(url.searchParams.get('extension_id')).toBe('a'.repeat(32));
    expect(url.searchParams.get('nonce')).toBe((session.platformLogin as { nonce: string }).nonce);
    expect(url.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(paths).not.toContain('/local-login/redeem');
  });
  it('设备被撤销后停止重试，保留旧账号但明确要求重新连接', async () => {
    local.platformUserSession = saved();
    apiFaults['/user/tasks'] = { status: 401, code: 'DEVICE_AUTH_REQUIRED' };
    await boot();
    expect((await state()).value).toMatchObject({
      authRequired: true,
      connected: false,
      user,
      task: null,
    });
    expect((await state()).value.error).toContain('请重新连接 OpenMAX');
    await vi.advanceTimersByTimeAsync(6000);
    expect(paths).toEqual(['/user/ticket', '/user/tasks']);
    expect(local.platformUserSession).toMatchObject({ access_token: 'old-user-session', user });
    expect(executor.attach).not.toHaveBeenCalled();
    expect(await internalMessage({ type: 'platform-disconnect' })).toMatchObject({ ok: true });
    expect(local.platformUserSession).toBeUndefined();
    expect((await state()).value).toMatchObject({ authRequired: false, user: null, error: '' });
    expect(paths).not.toContain('/local-login/logout');
  });
  it('在线时撤销立即关闭控制连接并释放本地控制', async () => {
    local.platformUserSession = saved();
    await boot();
    const socket = Socket.instances[0];
    if (!socket) throw new Error('Expected connected socket');
    expect((await state()).value.connected).toBe(true);
    apiFaults['/user/tasks'] = { status: 401, code: 'DEVICE_AUTH_REQUIRED' };
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(executor.release).toHaveBeenCalled();
    expect((await state()).value).toMatchObject({ connected: false, authRequired: true });
    expect(Socket.instances).toHaveLength(1);
  });
  it('服务器错误不是设备失效，会保留凭据并在恢复后重连', async () => {
    local.platformUserSession = saved();
    apiFaults['/user/tasks'] = { status: 503, code: 'BROWSER_INTERNAL_ERROR' };
    await boot();
    expect((await state()).value.authRequired).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(paths.filter((p) => p === '/user/tasks')).toHaveLength(2);
    delete apiFaults['/user/tasks'];
    await vi.advanceTimersByTimeAsync(2000);
    expect((await state()).value).toMatchObject({
      connected: true,
      authRequired: false,
      error: '',
    });
    expect(local.platformUserSession).toMatchObject({ access_token: 'old-user-session', user });
  });
  it('断开时才发现凭据失效，也允许移除本地记录', async () => {
    local.platformUserSession = saved();
    await boot();
    apiFaults['/local-login/logout'] = { status: 401, code: 'DEVICE_AUTH_REQUIRED' };
    expect(await internalMessage({ type: 'platform-disconnect' })).toMatchObject({ ok: true });
    expect(local.platformUserSession).toBeUndefined();
    expect((await state()).value.user).toBeNull();
  });
  it('撤销请求遇到服务器错误，不假装已经解绑成功', async () => {
    local.platformUserSession = saved();
    await boot();
    apiFaults['/local-login/logout'] = { status: 503, code: 'BROWSER_INTERNAL_ERROR' };
    expect(await internalMessage({ type: 'platform-disconnect' })).toMatchObject({ ok: false });
    expect(local.platformUserSession).toMatchObject({ access_token: 'old-user-session', user });
    expect((await state()).value.authRequired).toBe(false);
  });
  it('停止旧任务时发现设备失效，也能一次移除本地绑定', async () => {
    local.platformUserSession = saved();
    deviceTasks = [
      {
        id,
        endpoint_id: id,
        connection_epoch: id,
        owner_identity_id: id,
        activation_id: id,
        state: 'awaiting_consent',
        revision: '1',
        control_session_id: '',
        deadline: new Date(Date.now() + 60000).toISOString(),
        absolute_deadline: new Date(Date.now() + 1800000).toISOString(),
        outcome: '',
        cleanup_state: 'not_required',
      },
    ];
    await boot();
    apiFaults[`/tasks/${id}/stop`] = { status: 401, code: 'DEVICE_AUTH_REQUIRED' };
    expect(await internalMessage({ type: 'platform-disconnect' })).toMatchObject({ ok: true });
    expect(local.platformUserSession).toBeUndefined();
    expect((await state()).value).toMatchObject({ authRequired: false, user: null, task: null });
  });
  it('设备失效后网页重新确认可换成新凭据，不自动重用旧授权', async () => {
    local.platformUserSession = saved();
    apiFaults['/user/tasks'] = { status: 401, code: 'DEVICE_AUTH_REQUIRED' };
    await boot();
    expect((await state()).value.authRequired).toBe(true);
    delete apiFaults['/user/tasks'];
    expect(await message()).toMatchObject({ ok: true, status: 'bound', connected: true });
    expect(local.platformUserSession).toMatchObject({ access_token: 'test-user-session' });
    expect((await state()).value).toMatchObject({ authRequired: false, connected: true });
    expect(executor.attach).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const state = () =>
  new Promise((resolve) => internal({ type: 'platform-state' }, {}, resolve)).then((reply) => {
    if (!reply || typeof reply !== 'object' || !('value' in reply))
      throw new Error('Missing state');
    return { value: platformStateSchema.parse(reply.value) };
  });
const message = (m: unknown = request, s: unknown = sender) =>
  new Promise((resolve) => external(m, s, resolve));
async function boot() {
  startPlatformBackground();
  await state();
  await vi.advanceTimersByTimeAsync(1);
}

describe('网页一次确认绑定', () => {
  it('客户端跳转到登录页后无需刷新，仍校验同一标签和 nonce', async () => {
    await boot();
    const staleSender = { ...sender, url: 'http://localhost:3000/workspace' };
    expect(await message({ ...request, nonce: 'x'.repeat(43) }, staleSender)).toMatchObject({
      ok: false,
    });
    expect(await message(request, staleSender)).toMatchObject({ ok: true, status: 'bound' });
    expect(paths.filter((p) => p === '/local-login/redeem')).toHaveLength(1);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('客户端跳转到登录页可直接开始连接，不要求插件 Popup', async () => {
    await boot();
    expect(
      await message(
        { type: 'browser-binding-start' },
        { ...sender, url: 'http://localhost:3000/workspace' },
      ),
    ).toMatchObject({ ok: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(session.platformLogin).toMatchObject({ tabId: 7 });
  });
  it.each(['http://localhost:3000/workspace', 'https://evil.test/workspace/account'])(
    '登录回调的当前页面已离开时拒绝兑换：%s',
    async (url) => {
      await boot();
      vi.mocked(chrome.tabs.get).mockImplementation(
        async () => ({ ...sender.tab, url }) as chrome.tabs.Tab,
      );
      expect(await message()).toMatchObject({ ok: false, error: 'INVALID_BINDING_CALLBACK' });
      expect(await message({ type: 'browser-binding-start' })).toMatchObject({
        ok: false,
        error: 'INVALID_BINDING_CALLBACK',
      });
      expect(paths).not.toContain('/local-login/redeem');
    },
  );
  it('登录页已关闭时给出明确拒绝，不兑换凭据', async () => {
    await boot();
    vi.mocked(chrome.tabs.get).mockRejectedValue(new Error('No tab with id: 7'));
    expect(await message()).toMatchObject({ ok: false, error: 'INVALID_BINDING_CALLBACK' });
    expect(paths).not.toContain('/local-login/redeem');
  });
  it('无需 Popup，先保存凭据再确认，并自动建立连接但不创建工作页', async () => {
    await boot();
    expect(await message()).toEqual({ ok: true, status: 'bound', connected: true });
    expect(local.platformUserSession).toMatchObject({ access_token: 'test-user-session', user });
    expect(session.platformLogin).toBeUndefined();
    expect((await state()).value).toMatchObject({ user, loginPending: false, busy: false });
    expect(paths).toEqual(['/local-login/redeem', '/user/ticket']);
    expect(executor.attach).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(JSON.stringify(local)).not.toContain(request.code);
  });
  it('正在兑换时相同回调合并，不同回调和 Popup 操作拒绝', async () => {
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<unknown>();
    redeem = () => {
      entered.resolve();
      return result.promise;
    };
    await boot();
    const first = message();
    await entered.promise;
    const duplicate = message();
    expect(await message({ ...request, code: 'd'.repeat(43) })).toMatchObject({
      ok: false,
      error: 'BROWSER_BUSY',
    });
    const stop = await new Promise((resolve) =>
      internal({ type: 'platform-decide', action: 'stop', taskId: id }, {}, resolve),
    );
    expect(stop).toMatchObject({ ok: false, error: '操作处理中' });
    const restart = await new Promise((resolve) =>
      internal({ type: 'platform-login' }, {}, resolve),
    );
    expect(restart).toMatchObject({ ok: false });
    result.resolve(credentials());
    expect(await first).toMatchObject({ ok: true, status: 'bound' });
    expect(await duplicate).toMatchObject({ ok: true, status: 'bound' });
    expect(paths.filter((p) => p === '/local-login/redeem')).toHaveLength(1);
  });
  it('重启恢复已完成回执，重复回调不再兑换', async () => {
    await boot();
    await message();
    vi.clearAllTimers();
    await boot();
    expect(await message()).toMatchObject({ ok: true, status: 'bound' });
    expect(paths.filter((p) => p === '/local-login/redeem')).toHaveLength(1);
  });
  it.each([
    { frameId: 1 },
    { frameId: undefined },
    { tab: { id: 8 } },
    { tab: { id: 7, incognito: true } },
    { url: 'https://evil.test/workspace/account' },
  ])('拒绝非发起顶层页面 %j', async (change) => {
    await boot();
    expect(await message(request, { ...sender, ...change })).toMatchObject({ ok: false });
    expect(paths).toEqual([]);
  });
  it('拒绝过期、错误 nonce 和旧版回调，未执行兑换', async () => {
    await boot();
    expect(await message({ ...request, nonce: 'x'.repeat(43) })).toMatchObject({ ok: false });
    expect(
      await message({ type: 'browser-binding', code: request.code, nonce: request.nonce }),
    ).toMatchObject({ ok: false });
    vi.setSystemTime(Date.now() + 600001);
    expect(await message()).toMatchObject({ ok: false });
    expect(paths).toEqual([]);
  });
  it('用户登录拒绝 Agent 绑定字段，不发生兑换', async () => {
    await boot();
    expect(await message({ ...request, agent_member_id: id })).toMatchObject({ ok: false });
    expect(paths).toEqual([]);
  });
  it('relay 离线仍如实报告已绑定但未在线，定时器自动重连', async () => {
    connectFails = true;
    await boot();
    expect(await message()).toEqual({ ok: true, status: 'bound', connected: false });
    connectFails = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(await message()).toEqual({ ok: true, status: 'bound', connected: true });
    expect(paths.filter((p) => p === '/local-login/redeem')).toHaveLength(1);
  });
  it('兑换成功但保存失败不报成功，不盲目重放兑换', async () => {
    await boot();
    vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error('storage unavailable'));
    expect(await message()).toMatchObject({ ok: false });
    expect(await message()).toMatchObject({ ok: false });
    expect(local.platformUserSession).toBeUndefined();
    expect(paths.filter((p) => p === '/local-login/redeem')).toHaveLength(1);
  });
  it.each([
    {
      code: request.code,
      verifier: 'v',
      nonce: request.nonce,
      expires: Date.now() + 600000,
    },
    {
      version: 3,
      redeeming: true,
      tabId: 7,
      verifier: 'v',
      nonce: request.nonce,
      expires: Date.now() + 600000,
    },
  ])('旧版待确认或中断兑换不可在重启时自动授权', async (pending) => {
    session.platformLogin = pending;
    await boot();
    expect((await state()).value.loginPending).toBe(false);
    expect(await message()).toMatchObject({ ok: false });
    expect(paths).toEqual([]);
  });
  it('新的登录流程持久化发起 tab 与版本，重启后仍等待网页确认', async () => {
    session.platformLogin = undefined;
    await boot();
    const login = await new Promise((resolve) => internal({ type: 'platform-login' }, {}, resolve));
    expect(login).toMatchObject({ ok: true, value: { loginPending: true } });
    expect(session.platformLogin).toMatchObject({ version: 3, tabId: 7 });
    expect(chrome.tabs.create).toHaveBeenCalledOnce();
    vi.clearAllTimers();
    await boot();
    expect((await state()).value.loginPending).toBe(true);
    expect(paths).toEqual([]);
  });
});

describe('从 Connector 开始连接', () => {
  it('网页握手仅返回公开参数，后台保管 verifier，不创建标签', async () => {
    delete session.platformLogin;
    await boot();
    const response = await new Promise<Record<string, unknown>>((r) =>
      external({ type: 'browser-binding-start' }, sender, (v) => r(v as Record<string, unknown>)),
    );
    expect(response.ok).toBe(true);
    expect(response.params).toMatchObject({ extension_id: 'a'.repeat(32) });
    expect(Object.keys(response.params as object).sort()).toEqual([
      'challenge',
      'extension_id',
      'nonce',
    ]);
    expect(session.platformLogin).toMatchObject({ tabId: 7 });
    expect(JSON.stringify(response)).not.toContain('verifier');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(executor.attach).not.toHaveBeenCalled();
    expect(paths).toEqual([]);
  });
  it('其他页面和 iframe 不能启动连接', async () => {
    delete session.platformLogin;
    await boot();
    for (const bad of [
      { ...sender, frameId: 1 },
      { ...sender, url: 'https://evil.test/workspace/account' },
    ]) {
      expect(
        await new Promise((r) => external({ type: 'browser-binding-start' }, bad, r)),
      ).toMatchObject({ ok: false });
    }
    expect(session.platformLogin).toBeUndefined();
  });
});
