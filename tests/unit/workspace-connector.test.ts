// @vitest-environment node
import { expect, test, vi } from 'vitest';
import {
  POLL_INTERVAL_MS,
  PREPARE_TIMEOUT_MS,
  WorkspaceConnector,
  connectionLabel,
  isSecureRelayUrl,
  prepareErrorKey,
  queuedRelayClear,
  queuedRelayWrite,
  shortConnectionId,
  type ConnectorDeps,
} from '../../utils/workspace/connector';
import {
  WorkspaceApiError,
  workspaceAgentSchema,
  type WorkspaceApi,
} from '../../utils/workspace/api';
import { WorkspaceAuthError, type KeyValueStorage } from '../../utils/workspace/token-store';
import { WORKSPACE_CONNECTION_KEY } from '../../utils/workspace/config';

function memoryStorage() {
  const data = new Map<string, unknown>();
  const storage: KeyValueStorage = {
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
  return { storage, data };
}

const conn = (state: string, extra: object = {}) => ({
  connection: {
    connection_id: 'c1',
    agent_member_id: 'ag1',
    browser_instance_id: 'b1',
    browser_name: 'Chrome · Mac',
    state,
    online: false,
    ...extra,
  },
});

function setup(states: object[], storage = memoryStorage()) {
  const relay = { url: '', key: '', connected: false };
  const api = {
    listAgents: vi.fn(async () => [
      { agent_member_id: 'ag1', display_name: 'Max', authorized: false, active_connections: 0 },
    ]),
    createConnection: vi.fn(async () => conn('preparing').connection),
    getConnection: vi.fn(async () => states.shift() ?? conn('preparing')),
    reportConnected: vi.fn(async () => conn('connected').connection),
    revoke: vi.fn(async () => conn('revoked').connection),
  };
  const deps: ConnectorDeps = {
    api: api as unknown as WorkspaceApi,
    storage: storage.storage,
    authStatus: async () => 'signed-in',
    baseUrl: () => 'https://ws.example',
    browserId: () => 'b1',
    applyRelay: vi.fn(async (url: string, key: string, isCurrent: () => boolean) => {
      if (!isCurrent()) return undefined;
      relay.url = url;
      relay.key = key;
      return `kid-${key}`;
    }),
    keyIdOf: async (key: string) => `kid-${key}`,
    clearRelay: vi.fn(async (url: string, kid: string) => {
      if (deps.relayMatches(url, kid)) relay.key = '';
    }),
    relayMatches: (url, kid) => !!relay.key && relay.url === url && `kid-${relay.key}` === kid,
    relayConnected: () => relay.connected,
    publish: vi.fn(),
    sleep: async () => {},
  };
  return { connector: new WorkspaceConnector(deps), api, deps, relay, storage };
}

const ready = conn('ready', { key_id: 'k' });
const input = {
  agentMemberId: 'ag1',
  agentName: 'Max',
  browserName: 'Chrome · Mac',
  confirm: true,
};

test('connect: create → poll preparing → ready → relay config written → connected', async () => {
  const { connector, api, deps, relay } = setup([
    conn('preparing'),
    { ...ready, relay_url: 'wss://relay/ext', key: 'abc' },
  ]);
  await connector.init();
  await connector.connect(input);
  expect(api.createConnection).toHaveBeenCalledWith({
    agentMemberId: 'ag1',
    browserName: 'Chrome · Mac',
    confirm: true,
    browserInstanceId: 'b1',
  });
  expect(api.getConnection).toHaveBeenCalledTimes(2);
  expect(deps.applyRelay).toHaveBeenCalledWith('wss://relay/ext', 'abc', expect.any(Function));
  expect(relay.key).toBe('abc');
  expect(connector.view().connection).toMatchObject({ phase: 'connected', agentName: 'Max' });
  expect(JSON.stringify(connector.view())).not.toContain('abc');
  expect(connector.ownsRelay()).toBe(true);
  // Relay handshake → report connected once; heartbeat only while connected.
  await connector.onRelayReady();
  await connector.onRelayReady();
  expect(api.reportConnected).toHaveBeenCalledTimes(1);
  expect(api.reportConnected).toHaveBeenCalledWith('c1', 'b1');
});

test('prepare failure → failed with retry', async () => {
  const { connector, deps } = setup([conn('failed', { last_error: 'x' })]);
  await connector.connect(input);
  expect(connector.view().connection).toMatchObject({
    phase: 'failed',
    error: 'ui.error.workspacePrepareFailed',
  });
  expect(deps.applyRelay).not.toHaveBeenCalled();
});

test('Workspace auth failure while preparing → log in again, relay untouched', async () => {
  const { connector, api, deps } = setup([]);
  api.getConnection.mockRejectedValueOnce(new WorkspaceAuthError('logged-out', 'x'));
  deps.authStatus = async () => 'expired';
  await connector.connect(input);
  expect(connector.view().auth).toBe('expired');
  expect(connector.view().connection?.error).toBe('ui.error.workspaceLoginExpiredError');
  expect(deps.clearRelay).not.toHaveBeenCalled();
});

test('heartbeat failure from Workspace never disconnects the relay', async () => {
  const { connector, api, deps, relay } = setup([{ ...ready, relay_url: 'wss://r', key: 'k1' }]);
  await connector.connect(input);
  relay.connected = true;
  api.reportConnected.mockRejectedValueOnce(new WorkspaceAuthError('logged-out', 'x'));
  await connector.heartbeat();
  expect(deps.clearRelay).not.toHaveBeenCalled();
  expect(relay.key).toBe('k1');
  expect(connector.view().connection?.phase).toBe('connected');
});

test('relay 4004 clears the Key; Reconnect re-creates for the same Agent without confirm', async () => {
  const { connector, api, deps, relay } = setup([
    { ...ready, relay_url: 'wss://r', key: 'k1' },
    { ...ready, relay_url: 'wss://r', key: 'k2' },
  ]);
  await connector.connect(input);
  await connector.onKeyRejected(4004);
  expect(deps.clearRelay).toHaveBeenCalled();
  expect(connector.view().connection).toMatchObject({
    phase: 'key-rejected',
    error: 'ui.error.workspaceKeyRevoked',
  });
  await connector.reconnect();
  expect(api.createConnection).toHaveBeenLastCalledWith(
    expect.objectContaining({ agentMemberId: 'ag1', confirm: false }),
  );
  expect(relay.key).toBe('k2');
  expect(connector.view().connection?.phase).toBe('connected');
});

test('4003 is ignored when the relay is a manual config', async () => {
  const { connector, deps } = setup([]);
  await connector.onKeyRejected(4003);
  expect(deps.clearRelay).not.toHaveBeenCalled();
});

test('worker restart while preparing resumes polling the same connection', async () => {
  const storage = memoryStorage();
  storage.data.set(WORKSPACE_CONNECTION_KEY, {
    agentMemberId: 'ag1',
    agentName: 'Max',
    browserName: 'B',
    phase: 'preparing',
    connectionId: 'c1',
    startedAt: Date.now(),
  });
  const { connector, api, deps } = setup([{ ...ready, relay_url: 'wss://r', key: 'k1' }], storage);
  await connector.init();
  await vi.waitFor(() => expect(connector.view().connection?.phase).toBe('connected'));
  expect(api.createConnection).not.toHaveBeenCalled();
  expect(deps.applyRelay).toHaveBeenCalledWith('wss://r', 'k1', expect.any(Function));
});

test('switching Agent cancels a stale poll; revoke clears relay and record', async () => {
  const { connector, api, deps, storage } = setup([{ ...ready, relay_url: 'wss://r', key: 'k1' }]);
  await connector.connect(input);
  await connector.revoke();
  expect(api.revoke).toHaveBeenCalledWith('c1');
  expect(deps.clearRelay).toHaveBeenCalled();
  expect(connector.view().connection).toBeUndefined();
  expect(storage.data.has(WORKSPACE_CONNECTION_KEY)).toBe(false);
});

test('revoke failure keeps local state and reports', async () => {
  const { connector, api } = setup([{ ...ready, relay_url: 'wss://r', key: 'k1' }]);
  await connector.connect(input);
  api.revoke.mockRejectedValueOnce(new WorkspaceApiError(503, 'X', 'down'));
  await expect(connector.revoke()).rejects.toThrow('ui.error.workspaceUnreachable');
  expect(connector.view().connection?.phase).toBe('connected');
});

test('agents list maps to the panel view', async () => {
  const { connector } = setup([]);
  await connector.loadAgents();
  expect(connector.view().agents).toEqual([{ id: 'ag1', name: 'Max', authorized: false }]);
});

test.each([
  [403, 'ui.error.workspaceAgentUnavailable'],
  [404, 'ui.error.workspaceAgentNotFound'],
  [429, 'ui.error.workspaceRateLimited'],
  [503, 'ui.error.workspaceUnreachable'],
  [400, 'ui.error.workspaceRequestFailed'],
])('connect failure %i maps to a specific error', async (status, error) => {
  const { connector, api } = setup([]);
  await connector.init();
  api.createConnection.mockRejectedValueOnce(new WorkspaceApiError(status, 'X', 'x'));
  await connector.connect(input);
  expect(connector.view().connection).toMatchObject({ phase: 'failed', error });
});

test.each([
  [404, 'ui.error.workspaceAgentsLoadFailed'],
  [400, 'ui.error.workspaceAgentsLoadFailed'],
  [0, 'ui.error.workspaceUnreachable'],
])('agent list failure %i uses list wording', async (status, error) => {
  const { connector, api } = setup([]);
  await connector.init();
  api.listAgents.mockRejectedValueOnce(new WorkspaceApiError(status, 'X', 'x'));
  await connector.loadAgents();
  expect(connector.view().error).toBe(error);
});

test('agents list maps online_status; missing/unrecognised (old server) means no status', async () => {
  const { connector, api } = setup([]);
  api.listAgents.mockResolvedValueOnce([
    {
      agent_member_id: 'ag1',
      display_name: 'Max',
      authorized: true,
      active_connections: 0,
      online_status: 'online',
    },
    {
      agent_member_id: 'ag2',
      display_name: 'Ada',
      authorized: true,
      active_connections: 0,
      online_status: 'offline',
    },
    {
      agent_member_id: 'ag4',
      display_name: 'Unk',
      authorized: true,
      active_connections: 0,
      online_status: 'unknown',
    },
    { agent_member_id: 'ag3', display_name: 'Old', authorized: true, active_connections: 0 },
  ] as never);
  await connector.loadAgents();
  expect(connector.view().agents).toEqual([
    { id: 'ag1', name: 'Max', authorized: true, status: 'online' },
    { id: 'ag2', name: 'Ada', authorized: true, status: 'offline' },
    { id: 'ag4', name: 'Unk', authorized: true, status: 'unknown' },
    { id: 'ag3', name: 'Old', authorized: true },
  ]);
});

test('BROWSER_AGENT_OFFLINE on connect → back to a refreshed picker with the offline error', async () => {
  const { connector, api, deps } = setup([]);
  api.createConnection.mockRejectedValueOnce(
    new WorkspaceApiError(409, 'BROWSER_AGENT_OFFLINE', 'offline'),
  );
  await connector.connect(input);
  expect(connector.view().connection).toBeUndefined();
  expect(connector.view().error).toBe('ui.error.workspaceAgentOffline');
  expect(api.listAgents).toHaveBeenCalledTimes(1);
  expect(connector.view().agents).toHaveLength(1);
  expect(deps.applyRelay).not.toHaveBeenCalled();
});

test('BROWSER_AGENT_OFFLINE while polling also returns to the picker', async () => {
  const { connector, api } = setup([]);
  api.getConnection.mockRejectedValueOnce(
    new WorkspaceApiError(409, 'BROWSER_AGENT_OFFLINE', 'offline'),
  );
  await connector.connect(input);
  expect(connector.view().connection).toBeUndefined();
  expect(connector.view().error).toBe('ui.error.workspaceAgentOffline');
});

test('cancel while preparing revokes the pending connection, stops polling, ignores a late ready', async () => {
  const { connector, api, deps, relay, storage } = setup([]);
  let release!: (v: unknown) => void;
  api.getConnection.mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
  const connecting = connector.connect(input);
  await vi.waitFor(() => expect(api.getConnection).toHaveBeenCalledTimes(1));
  await connector.cancel();
  expect(api.revoke).toHaveBeenCalledWith('c1');
  expect(connector.view().connection).toBeUndefined();
  expect(storage.data.has(WORKSPACE_CONNECTION_KEY)).toBe(false);
  // The cancelled attempt's poll now sees "ready": it must not write the relay.
  release({ ...ready, relay_url: 'wss://late', key: 'late' });
  await connecting;
  expect(deps.applyRelay).not.toHaveBeenCalled();
  expect(relay.key).toBe('');
  expect(api.getConnection).toHaveBeenCalledTimes(1);
  expect(connector.view().connection).toBeUndefined();
});

test('cancel while the create is in flight abandons the created connection', async () => {
  const { connector, api, deps } = setup([]);
  let release!: (v: unknown) => void;
  api.createConnection.mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
  const connecting = connector.connect(input);
  await vi.waitFor(() => expect(api.createConnection).toHaveBeenCalled());
  await connector.cancel();
  expect(api.revoke).not.toHaveBeenCalled();
  release(conn('preparing').connection);
  await connecting;
  expect(api.revoke).toHaveBeenCalledWith('c1');
  expect(api.getConnection).not.toHaveBeenCalled();
  expect(deps.applyRelay).not.toHaveBeenCalled();
});

test('cancel clears the pending poll timer (real sleep)', async () => {
  vi.useFakeTimers();
  try {
    const { connector, api, deps } = setup([]);
    deps.sleep = undefined;
    const connecting = connector.connect(input);
    await vi.waitFor(() => expect(api.getConnection).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await connector.cancel();
    expect(vi.getTimerCount()).toBe(0);
    await connecting;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.getConnection).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test('cancel is a no-op once connected', async () => {
  const { connector, api } = setup([{ ...ready, relay_url: 'wss://r', key: 'k1' }]);
  await connector.connect(input);
  await connector.cancel();
  expect(api.revoke).not.toHaveBeenCalled();
  expect(connector.view().connection?.phase).toBe('connected');
});

test('preparing is bounded at 300s (≤ server prepare timeout): then failed (timeout) and the connection is abandoned', async () => {
  expect(PREPARE_TIMEOUT_MS).toBe(300_000);
  let t = 0;
  const { connector, api, deps } = setup([]);
  deps.now = () => t;
  deps.sleep = async (ms) => {
    t += ms;
    // Still preparing just before the bound.
    if (t <= PREPARE_TIMEOUT_MS) expect(connector.view().connection?.phase).toBe('preparing');
  };
  await connector.connect(input);
  expect(connector.view().connection).toMatchObject({
    phase: 'failed',
    error: 'ui.error.workspacePrepareTimeout',
  });
  expect(t).toBeGreaterThan(PREPARE_TIMEOUT_MS - POLL_INTERVAL_MS);
  expect(t).toBeLessThanOrEqual(PREPARE_TIMEOUT_MS + POLL_INTERVAL_MS);
  await vi.waitFor(() => expect(api.revoke).toHaveBeenCalledWith('c1'));
  expect(deps.applyRelay).not.toHaveBeenCalled();
});

test('a run ended while "applying" is saved never writes the relay settings', async () => {
  const storage = memoryStorage();
  const { connector, deps } = setup([{ ...ready, relay_url: 'wss://late', key: 'late' }], storage);
  const set = storage.storage.set;
  storage.storage.set = async (k, v) => {
    if ((v as { phase?: string })?.phase === 'applying') await connector.forgetLocal();
    return set(k, v);
  };
  await connector.connect(input);
  expect(deps.applyRelay).not.toHaveBeenCalled();
});

test('BROWSER_AGENT_STATUS_UNAVAILABLE (503) → picker kept with the status error, no list refresh', async () => {
  const { connector, api, deps } = setup([]);
  await connector.loadAgents();
  api.createConnection.mockRejectedValueOnce(
    new WorkspaceApiError(503, 'BROWSER_AGENT_STATUS_UNAVAILABLE', 'unavailable'),
  );
  await connector.connect(input);
  expect(connector.view().connection).toBeUndefined();
  expect(connector.view().error).toBe('ui.error.workspaceAgentStatusUnavailable');
  expect(api.listAgents).toHaveBeenCalledTimes(1);
  expect(connector.view().agents).toHaveLength(1);
  expect(deps.applyRelay).not.toHaveBeenCalled();
});

test('a plain 503 is still "Workspace unreachable" (failed state)', async () => {
  const { connector, api } = setup([]);
  api.createConnection.mockRejectedValueOnce(new WorkspaceApiError(503, 'X', 'down'));
  await connector.connect(input);
  expect(connector.view().connection).toMatchObject({
    phase: 'failed',
    error: 'ui.error.workspaceUnreachable',
  });
});

test('agent schema: online_status parsed; unrecognised value or legacy boolean online is ignored', () => {
  const base = { agent_member_id: 'a', display_name: 'A', authorized: true };
  expect(workspaceAgentSchema.parse({ ...base, online_status: 'unknown' }).online_status).toBe(
    'unknown',
  );
  const odd = workspaceAgentSchema.parse({ ...base, online_status: 'sleeping', online: false });
  expect(odd.online_status).toBeUndefined();
  expect('online' in odd).toBe(false);
  expect(workspaceAgentSchema.parse(base).online_status).toBeUndefined();
});

const agentB = {
  agentMemberId: 'ag2',
  agentName: 'Ada',
  browserName: 'Chrome · Mac',
  confirm: true,
};
const connectedA = async (extra: object[] = []) => {
  const h = setup([{ ...ready, relay_url: 'wss://r', key: 'kA' }, ...extra]);
  await h.connector.connect(input);
  expect(h.relay.key).toBe('kA');
  expect(h.connector.ownsRelay()).toBe(true);
  return h;
};

test("switch → B prepare fails: A's Key is cleared, and sign-out leaves nothing applied", async () => {
  const { connector, deps, relay } = await connectedA([conn('failed')]);
  await connector.connect(agentB);
  expect(connector.view().connection).toMatchObject({ agentMemberId: 'ag2', phase: 'failed' });
  expect(deps.clearRelay).toHaveBeenCalledTimes(1);
  expect(relay.key).toBe('');
  await connector.signedOut();
  expect(relay.key).toBe('');
  expect(connector.view().connection).toBeUndefined();
});

test("switch → cancelled: A's Key is cleared; a later 4004 is a no-op", async () => {
  const { connector, api, deps, relay } = await connectedA();
  let release!: (v: unknown) => void;
  api.getConnection.mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
  const switching = connector.connect(agentB);
  await vi.waitFor(() => expect(api.getConnection).toHaveBeenCalledTimes(2));
  await connector.cancel();
  release(conn('preparing'));
  await switching;
  expect(relay.key).toBe('');
  expect(deps.clearRelay).toHaveBeenCalledTimes(1);
  await connector.onKeyRejected(4004);
  expect(relay.key).toBe('');
  expect(connector.view().connection).toBeUndefined();
});

test("switch → 409 offline: A's Key is cleared before the attempt; revoke leaves nothing applied", async () => {
  const { connector, api, deps, relay } = await connectedA();
  api.createConnection.mockRejectedValueOnce(
    new WorkspaceApiError(409, 'BROWSER_AGENT_OFFLINE', 'offline'),
  );
  await connector.connect(agentB);
  expect(deps.clearRelay).toHaveBeenCalledTimes(1);
  expect(relay.key).toBe('');
  await connector.revoke();
  expect(relay.key).toBe('');
});

test("switch → timeout: A's Key is cleared", async () => {
  let t = 0;
  const { connector, deps, relay } = await connectedA();
  deps.now = () => t;
  deps.sleep = async (ms) => void (t += ms);
  await connector.connect(agentB);
  expect(connector.view().connection?.error).toBe('ui.error.workspacePrepareTimeout');
  expect(relay.key).toBe('');
});

test('signedOut clears the Workspace-owned relay', async () => {
  const { connector, deps, relay } = await connectedA();
  await connector.signedOut();
  expect(deps.clearRelay).toHaveBeenCalledTimes(1);
  expect(relay.key).toBe('');
});

test('relay 4003 on a Workspace Key clears it (Key in use elsewhere)', async () => {
  const { connector, relay } = await connectedA();
  await connector.onKeyRejected(4003);
  expect(relay.key).toBe('');
  expect(connector.view().connection).toMatchObject({
    phase: 'key-rejected',
    error: 'ui.error.workspaceKeyElsewhere',
  });
});

test('worker died after writing the relay but before "connected": init clears the orphan Key', async () => {
  const storage = memoryStorage();
  storage.data.set(WORKSPACE_CONNECTION_KEY, {
    agentMemberId: 'ag1',
    agentName: 'Max',
    browserName: 'B',
    phase: 'applying',
    connectionId: 'c1',
    relayUrl: 'wss://r',
    localKeyId: 'kid-orphan',
  });
  const { connector, deps, relay } = setup([], storage);
  relay.url = 'wss://r';
  relay.key = 'orphan';
  await connector.init();
  expect(deps.clearRelay).toHaveBeenCalledTimes(1);
  expect(relay.key).toBe('');
  expect(connector.view().connection?.phase).toBe('failed');
});

test.each([
  ['a different URL', 'wss://manual'],
  ['the same URL with a manual Key', 'wss://r'],
])('init never touches a manual config (%s)', async (_label, url) => {
  const storage = memoryStorage();
  storage.data.set(WORKSPACE_CONNECTION_KEY, {
    agentMemberId: 'ag1',
    agentName: 'Max',
    browserName: 'B',
    phase: 'applying',
    connectionId: 'c1',
    relayUrl: 'wss://r',
    localKeyId: 'kid-orphan',
  });
  const { connector, deps, relay } = setup([], storage);
  relay.url = url;
  relay.key = 'manual';
  await connector.init();
  expect(deps.clearRelay).not.toHaveBeenCalled();
  expect(relay.key).toBe('manual');
});

test('worker dies mid-write on the real poll path: restart clears exactly that Key', async () => {
  const storage = memoryStorage();
  const { connector, deps, relay } = setup(
    [{ ...ready, relay_url: 'wss://r', key: 'k1' }],
    storage,
  );
  let written!: () => void;
  const landed = new Promise<void>((resolve) => (written = resolve));
  deps.applyRelay = vi.fn(async (url: string, key: string) => {
    relay.url = url;
    relay.key = key;
    written();
    return new Promise<string>(() => {}); // the worker dies before "connected"
  });
  void connector.connect(input);
  await landed;
  expect(storage.data.get(WORKSPACE_CONNECTION_KEY)).toMatchObject({
    phase: 'applying',
    relayUrl: 'wss://r',
    localKeyId: 'kid-k1',
  });
  const restarted = new WorkspaceConnector(deps);
  await restarted.init();
  expect(relay.key).toBe('');
  expect(restarted.view().connection?.phase).toBe('failed');
});

test.each([
  ['sign-out', (c: WorkspaceConnector) => c.signedOut()],
  ['revoke', (c: WorkspaceConnector) => c.revoke()],
  ['switch', (c: WorkspaceConnector) => c.connect({ ...input, agentMemberId: 'ag2' })],
])('%s while the relay write is in flight clears the Key it wrote', async (_label, act) => {
  const { connector, deps, relay } = setup([{ ...ready, relay_url: 'wss://r', key: 'k1' }]);
  let entered!: () => void;
  const inWrite = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  // The switched-to attempt keeps preparing (no busy loop).
  deps.sleep = () => new Promise<void>(() => {});
  // Past the isCurrent check, the write lands only after the session ended.
  deps.applyRelay = vi.fn(async (url: string, key: string, isCurrent: () => boolean) => {
    if (!isCurrent()) return undefined;
    entered();
    await gate;
    relay.url = url;
    relay.key = key;
    return `kid-${key}`;
  });
  const connecting = connector.connect(input);
  await inWrite;
  const acting = act(connector);
  release();
  await connecting;
  void acting.catch(() => {}); // a switch keeps preparing
  await vi.waitFor(() => expect(relay.key).toBe(''));
});

test('a manual save that replaced the in-flight Workspace write is not cleared', async () => {
  const { connector, deps, relay } = setup([{ ...ready, relay_url: 'wss://r', key: 'k1' }]);
  deps.applyRelay = vi.fn(async (url: string, key: string) => {
    relay.url = url;
    relay.key = key;
    await connector.forgetLocal();
    // The owner's manual save lands right after.
    relay.url = 'wss://r';
    relay.key = 'manual';
    return `kid-${key}`;
  });
  await connector.connect(input);
  // The cleanup runs but finds a Key that is not the one it wrote.
  expect(deps.clearRelay).toHaveBeenCalledWith('wss://r', 'kid-k1');
  expect(relay.key).toBe('manual');
});

test('queuedRelayWrite skips the write when the run was superseded while queued', async () => {
  const saveConnection = vi.fn(async () => {});
  const mutate = <T>(run: () => Promise<T>) => run();
  const apply = queuedRelayWrite(mutate, saveConnection, () => 'kid');
  await expect(apply('wss://r', 'k', () => false)).resolves.toBeUndefined();
  expect(saveConnection).not.toHaveBeenCalled();
  await expect(apply('wss://r', 'k', () => true)).resolves.toBe('kid');
  expect(saveConnection).toHaveBeenCalledWith('wss://r', 'k');
});

function queue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run);
    tail = next.catch(() => {});
    return next;
  };
}

/** Deps whose relay write/clear go through one mutate queue, like remote.ts. */
function queuedSetup() {
  const s = setup([{ ...ready, relay_url: 'wss://r', key: 'k1' }]);
  const mutate = queue();
  let entered!: () => void;
  const inWrite = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const save = async (url: string, key: string) => {
    s.relay.url = url;
    s.relay.key = key;
  };
  s.deps.applyRelay = vi.fn((url: string, key: string, isCurrent: () => boolean) =>
    mutate(async () => {
      if (!isCurrent()) return undefined;
      entered();
      await gate;
      await save(url, key);
      return `kid-${key}`;
    }),
  );
  s.deps.clearRelay = vi.fn(queuedRelayClear(mutate, (url) => save(url, ''), s.deps.relayMatches));
  return { ...s, mutate, save, inWrite, release };
}

test('a manual save queued between a mid-write sign-out and its cleanup keeps its Key', async () => {
  const { connector, deps, relay, mutate, save, inWrite, release } = queuedSetup();
  const connecting = connector.connect(input);
  await inWrite;
  const signingOut = connector.signedOut();
  const manual = mutate(() => save('wss://manual', 'kM'));
  release();
  await Promise.all([connecting, signingOut, manual]);
  await vi.waitFor(() => expect(deps.clearRelay).toHaveBeenCalled());
  await mutate(async () => {});
  expect(relay).toMatchObject({ url: 'wss://manual', key: 'kM' });
});

test("a switch to B that becomes ready fast keeps B's Key through A's cleanup", async () => {
  const { connector, api, deps, relay, mutate, inWrite, release } = queuedSetup();
  const connecting = connector.connect(input);
  await inWrite;
  api.createConnection.mockResolvedValueOnce({
    ...conn('preparing').connection,
    connection_id: 'c2',
  });
  api.getConnection.mockResolvedValueOnce({ ...ready, relay_url: 'wss://r', key: 'kB' });
  const switching = connector.connect({ ...input, agentMemberId: 'ag2' });
  // B's write is queued behind A's before A's cleanup is.
  await vi.waitFor(() => expect(deps.applyRelay).toHaveBeenCalledTimes(2));
  release();
  await Promise.all([connecting, switching]);
  await mutate(async () => {});
  expect(deps.clearRelay).toHaveBeenCalledWith('wss://r', 'kid-k1');
  expect(relay.key).toBe('kB');
  expect(connector.view().connection).toMatchObject({ phase: 'connected', agentMemberId: 'ag2' });
  expect(connector.ownsRelay()).toBe(true);
});

test('queuedRelayClear clears only the Key it was given, checked when it runs', async () => {
  const clearKey = vi.fn(async () => {});
  let current = { url: 'wss://r', kid: 'kid-a' };
  const clear = queuedRelayClear(
    (run) => run(),
    clearKey,
    (url, kid) => current.url === url && current.kid === kid,
  );
  await clear('wss://r', 'kid-b');
  expect(clearKey).not.toHaveBeenCalled();
  current = { url: 'wss://r', kid: 'kid-b' };
  await clear('wss://r', 'kid-b');
  expect(clearKey).toHaveBeenCalledWith('wss://r');
});

test('a sign-out while the key id is computed stops before anything is recorded or written', async () => {
  const { connector, deps, relay, storage } = setup([
    { ...ready, relay_url: 'wss://r', key: 'k1' },
  ]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inKeyId = new Promise<void>((resolve) => (entered = resolve));
  deps.keyIdOf = async (key) => {
    entered();
    await gate;
    return `kid-${key}`;
  };
  const connecting = connector.connect(input);
  await inKeyId;
  await connector.signedOut();
  release();
  await connecting;
  expect(deps.applyRelay).not.toHaveBeenCalled();
  expect(relay.key).toBe('');
  expect(storage.data.get(WORKSPACE_CONNECTION_KEY)).toBeUndefined();
});

test('the key id is computed from the trimmed Key, as saveConnection stores it', async () => {
  const { connector, deps } = setup([{ ...ready, relay_url: 'wss://r', key: ' k1 \n' }]);
  const keyIdOf = vi.fn(deps.keyIdOf);
  deps.keyIdOf = keyIdOf;
  await connector.connect(input);
  expect(keyIdOf).toHaveBeenCalledWith('k1');
});

test('connecting again abandons the previous attempt that is still preparing', async () => {
  const { connector, api, deps } = setup([]);
  let release!: () => void;
  deps.sleep = () => new Promise<void>((resolve) => (release = resolve));
  void connector.connect(input);
  await vi.waitFor(() => expect(api.getConnection).toHaveBeenCalled());
  api.createConnection.mockResolvedValueOnce({
    ...conn('preparing').connection,
    connection_id: 'c2',
  });
  const second = connector.connect({ ...input, agentMemberId: 'ag2' });
  await vi.waitFor(() => expect(api.revoke).toHaveBeenCalledWith('c1'));
  expect(api.revoke).not.toHaveBeenCalledWith('c2');
  release();
  void second;
});

test('a switch whose disconnect fails reports it and keeps the current session', async () => {
  const { connector, api, deps, relay } = setup([{ ...ready, relay_url: 'wss://r', key: 'k1' }]);
  await connector.connect(input);
  vi.mocked(deps.clearRelay).mockRejectedValueOnce(new Error('storage'));
  // A switch that wrongly went ahead would park in a poll sleep and time out
  // instead of busy-looping.
  deps.sleep = () => new Promise<void>(() => {});
  await connector.connect({ ...input, agentMemberId: 'ag2' });
  expect(connector.view()).toMatchObject({
    error: 'ui.error.workspaceSwitchClearFailed',
    connection: { phase: 'connected', agentMemberId: 'ag1' },
  });
  expect(api.createConnection).toHaveBeenCalledTimes(1);
  expect(relay.key).toBe('k1');
  expect(connector.ownsRelay()).toBe(true);
});

test('release builds accept only wss:// relays (no ws:// loopback)', () => {
  expect(isSecureRelayUrl('wss://relay.example/ext', false)).toBe(true);
  expect(isSecureRelayUrl('ws://localhost:8080/ext', false)).toBe(false);
  expect(isSecureRelayUrl('ws://127.0.0.1/ext', false)).toBe(false);
  expect(isSecureRelayUrl('ws://localhost:8080/ext', true)).toBe(true);
});

test('the relay write is skipped when the run was superseded while it was queued', async () => {
  const { connector, deps, relay } = setup([{ ...ready, relay_url: 'wss://r', key: 'k1' }]);
  const apply = deps.applyRelay;
  // A manual save queued ahead of the write forgets the Workspace session.
  deps.applyRelay = vi.fn(async (url, key, isCurrent) => {
    await connector.forgetLocal();
    return apply(url, key, isCurrent);
  });
  await connector.connect(input);
  expect(relay.key).toBe('');
  expect(connector.view().connection).toBeUndefined();
  // Skipped, not written and then cleared (that would wipe a manual Key).
  expect(relay.url).toBe('');
  expect(deps.clearRelay).not.toHaveBeenCalled();
});

test.each([
  ['ws://relay.example/ext', false],
  ['http://relay.example/ext', false],
  ['ws://localhost:8080/ext', true],
  ['ws://127.0.0.1/ext', true],
])('Workspace relay URL %s accepted=%s', async (url, ok) => {
  const { connector, api, deps } = setup([{ ...ready, relay_url: url, key: 'k1' }]);
  await connector.connect(input);
  if (ok) expect(connector.view().connection?.phase).toBe('connected');
  else {
    expect(connector.view().connection).toMatchObject({
      phase: 'failed',
      error: 'ui.error.workspaceRelayInsecure',
    });
    expect(deps.applyRelay).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(api.revoke).toHaveBeenCalledWith('c1'));
  }
});

test.each([
  [
    'browser-remote is too old for OpenMax Browser: upgrade it to the release …',
    'ui.error.workspaceAgentBrowserRemoteOld',
  ],
  [
    'this Agent has no public domain, so OpenMax Browser cannot reach it (…); set AGENT_PUBLIC_BASE_URL=https://<public domain>',
    'ui.error.workspaceAgentNoPublicUrl',
  ],
  [
    'BROWSER_PUBLIC_URL_MISSING: Ask the Agent owner to configure its public HTTPS URL and retry. Agent session notice queued.',
    'ui.error.workspaceAgentNoPublicUrlNotified',
  ],
  [
    'BROWSER_PUBLIC_URL_MISSING: Ask the Agent owner to configure its public HTTPS URL and retry. Agent session notice recently queued.',
    'ui.error.workspaceAgentNoPublicUrlNotified',
  ],
  [
    'BROWSER_PUBLIC_URL_MISSING: Ask the Agent owner to configure its public HTTPS URL and retry. Agent session notice could not be queued.',
    'ui.error.workspaceAgentNoPublicUrlNotNotified',
  ],
  // The code without a recognizable notice state never claims a notice was sent.
  [
    'BROWSER_PUBLIC_URL_MISSING: configure a public HTTPS URL',
    'ui.error.workspaceAgentNoPublicUrl',
  ],
  ['AGENT_PUBLIC_BASE_URL is unset', 'ui.error.workspaceAgentNoPublicUrl'],
  [
    'AGENT_PUBLIC_BASE_URL in ~/zylos/.env is not a valid http(s) URL',
    'ui.error.workspaceAgentPublicUrlInvalid',
  ],
  [
    'the platform-bound domain is not a valid http(s) URL',
    'ui.error.workspaceAgentPublicUrlInvalid',
  ],
  ['something else', 'ui.error.workspacePrepareFailed'],
  ['notice queued', 'ui.error.workspacePrepareFailed'],
  [undefined, 'ui.error.workspacePrepareFailed'],
])('prepare last_error %s maps to %s', async (lastError, error) => {
  expect(prepareErrorKey(lastError)).toBe(error);
  const { connector } = setup([conn('failed', lastError ? { last_error: lastError } : {})]);
  await connector.connect(input);
  expect(connector.view().connection).toMatchObject({ phase: 'failed', error });
});

test('relay browser name: only a Workspace-owned relay reports the trimmed name; rename notifies', async () => {
  const { connector, api, deps, relay } = setup([
    { ...ready, relay_url: 'wss://relay/ext', key: 'abc' },
  ]);
  const onBrowserName = vi.fn();
  deps.onBrowserName = onBrowserName;
  (api as Record<string, unknown>).rename = vi.fn(async () => conn('connected').connection);
  await connector.init();
  expect(connector.relayBrowserName()).toBeUndefined();
  await connector.connect({ ...input, browserName: '  Work Laptop  ' });
  expect(connector.relayBrowserName()).toBe('Work Laptop');
  await connector.rename('  Home Mac ');
  expect((api as any).rename).toHaveBeenCalledWith('c1', 'Home Mac');
  expect(onBrowserName).toHaveBeenCalledWith('Home Mac');
  expect(connector.relayBrowserName()).toBe('Home Mac');
  await expect(connector.rename('   ')).rejects.toThrow('workspaceBrowserNameRequired');
  // A manual relay config is not Workspace-owned: no name is reported.
  relay.key = 'manual';
  expect(connector.relayBrowserName()).toBeUndefined();
});

test('browser names are cleaned as untrusted display text', async () => {
  const { cleanBrowserName } = await import('../../utils/workspace/connector');
  expect(cleanBrowserName(' Work\nLaptop\u0007 ')).toBe('Work Laptop');
  const long = '\u{1F600}'.repeat(150);
  const cleaned = cleanBrowserName(long);
  expect(Array.from(cleaned)).toHaveLength(100);
  expect(cleaned.endsWith('\u{1F600}')).toBe(true);
  expect(cleanBrowserName('x'.repeat(120))).toHaveLength(100);
});

test('rename does not notify the relay when the relay is not Workspace-owned', async () => {
  const { connector, api, deps, relay } = setup([
    { ...ready, relay_url: 'wss://relay/ext', key: 'abc' },
  ]);
  const onBrowserName = vi.fn();
  deps.onBrowserName = onBrowserName;
  (api as Record<string, unknown>).rename = vi.fn(async () => conn('connected').connection);
  await connector.init();
  await connector.connect({ ...input, browserName: 'Work' });
  relay.key = 'manual';
  await connector.rename('Home');
  expect((api as any).rename).toHaveBeenCalledWith('c1', 'Home');
  expect(onBrowserName).not.toHaveBeenCalled();
});

test('missing public URL copy only claims a notice when OpenMax reports it was queued', async () => {
  const { localizeError } = await import('../../utils/i18n');
  const text = (locale: 'zh-CN' | 'en', key: string) => localizeError(locale, `ui.error.${key}`);
  const notified = { 'zh-CN': /设置提醒已排队发给 Agent/, en: /reminder was queued for the Agent/ };
  for (const locale of ['zh-CN', 'en'] as const) {
    expect(text(locale, 'workspaceAgentNoPublicUrlNotified')).toMatch(notified[locale]);
    expect(text(locale, 'workspaceAgentNoPublicUrlNotNotified')).not.toMatch(notified[locale]);
    expect(text(locale, 'workspaceAgentNoPublicUrl')).not.toMatch(notified[locale]);
    for (const key of [
      'workspaceAgentNoPublicUrl',
      'workspaceAgentNoPublicUrlNotified',
      'workspaceAgentNoPublicUrlNotNotified',
    ])
      expect(text(locale, key)).toContain('AGENT_PUBLIC_BASE_URL');
  }
  expect(text('zh-CN', 'workspaceAgentNoPublicUrl')).not.toContain('已通知');
  expect(text('en', 'workspaceAgentNoPublicUrl')).not.toMatch(/notified/i);
  expect(text('zh-CN', 'workspaceAgentNoPublicUrlNotNotified')).toContain('没能发给 Agent');
  expect(text('en', 'workspaceAgentNoPublicUrlNotNotified')).toContain('could not be sent');
});

test('connection label is "name · first 8 chars of the connection id", like the Agent shows it', () => {
  const id = '6f62aefa-1234-4abc-8def-0123456789ab';
  expect(shortConnectionId(id)).toBe('6f62aefa');
  expect(shortConnectionId(`openmax:${id}`)).toBe('6f62aefa');
  expect(shortConnectionId(undefined)).toBe('');
  expect(connectionLabel('Mac mini · Work', id)).toBe('Mac mini · Work · 6f62aefa');
  // Before Workspace assigned an id there is nothing to add.
  expect(connectionLabel('Chrome · Mac')).toBe('Chrome · Mac');
});

test('the panel view carries the connection id once Workspace created the connection', async () => {
  const { connector } = setup([{ ...ready, relay_url: 'wss://relay/ext', key: 'abc' }]);
  await connector.init();
  await connector.connect(input);
  expect(connector.view().connection).toMatchObject({
    browserName: 'Chrome · Mac',
    connectionId: 'c1',
    phase: 'connected',
  });
  expect(JSON.stringify(connector.view())).not.toContain('abc');
});

test('rename updates the stored record and view; an unchanged name makes no request', async () => {
  const { connector, api, storage } = setup([{ ...ready, relay_url: 'wss://relay/ext', key: 'k' }]);
  const rename = vi.fn(async () => conn('connected').connection);
  (api as Record<string, unknown>).rename = rename;
  await connector.connect(input);
  await connector.rename('  Mac mini · Work ');
  expect(rename).toHaveBeenCalledWith('c1', 'Mac mini · Work');
  const renamed = connector.view().connection?.browserName;
  expect(renamed).toBe('Mac mini · Work');
  expect((storage.data.get(WORKSPACE_CONNECTION_KEY) as { browserName: string }).browserName).toBe(
    renamed,
  );
  rename.mockClear();
  await connector.rename(` ${renamed} `);
  expect(rename).not.toHaveBeenCalled();
});

test.each([
  [new WorkspaceApiError(404, 'NOT_FOUND', 'gone'), 'ui.error.workspaceRevoked'],
  [new WorkspaceApiError(403, 'FORBIDDEN', 'no'), 'ui.error.workspaceAgentUnavailable'],
  [new WorkspaceApiError(429, 'RATE', 'slow'), 'ui.error.workspaceRateLimited'],
  [new WorkspaceApiError(503, 'DOWN', 'down'), 'ui.error.workspaceUnreachable'],
  [new WorkspaceApiError(422, 'INVALID', 'bad name'), 'ui.error.workspaceRequestFailed'],
  [new WorkspaceAuthError('logged-out', 'x'), 'ui.error.workspaceLoginExpiredError'],
])('a failed rename (%s) reports %s and keeps the old name', async (error, code) => {
  const { connector, api, deps, storage } = setup([
    { ...ready, relay_url: 'wss://relay/ext', key: 'k' },
  ]);
  const onBrowserName = vi.fn();
  deps.onBrowserName = onBrowserName;
  (api as Record<string, unknown>).rename = vi.fn(async () => {
    throw error;
  });
  await connector.connect(input);
  vi.mocked(deps.publish).mockClear();
  await expect(connector.rename('Home')).rejects.toThrow(code);
  expect(connector.view().connection).toMatchObject({ browserName: 'Chrome · Mac' });
  expect((storage.data.get(WORKSPACE_CONNECTION_KEY) as { browserName: string }).browserName).toBe(
    'Chrome · Mac',
  );
  expect(onBrowserName).not.toHaveBeenCalled();
  expect(deps.publish).toHaveBeenCalled();
  // The connection itself is untouched by a failed rename.
  expect(connector.view().connection?.phase).toBe('connected');
});

test('rename needs a settled Workspace connection and a non-empty name', async () => {
  const { connector, api } = setup([]);
  const rename = vi.fn(async () => conn('connected').connection);
  (api as Record<string, unknown>).rename = rename;
  await expect(connector.rename('Home')).rejects.toThrow('workspaceRenameUnavailable');
  // Still preparing: the record has a connection id but is not settled.
  let release!: () => void;
  api.getConnection.mockImplementationOnce(
    () => new Promise((resolve) => (release = () => resolve(conn('preparing')))),
  );
  const connecting = connector.connect(input);
  await vi.waitFor(() => expect(connector.view().connection?.connectionId).toBe('c1'));
  expect(connector.view().connection?.phase).toBe('preparing');
  await expect(connector.rename('Home')).rejects.toThrow('workspaceRenameUnavailable');
  await expect(connector.rename(' \u0007 ')).rejects.toThrow('workspaceBrowserNameRequired');
  expect(rename).not.toHaveBeenCalled();
  await connector.cancel();
  release();
  await connecting;
});

test('a failed connection can still be renamed', async () => {
  const { connector, api } = setup([conn('failed', { last_error: 'x' })]);
  const rename = vi.fn(async () => conn('failed').connection);
  (api as Record<string, unknown>).rename = rename;
  await connector.connect(input);
  expect(connector.view().connection?.phase).toBe('failed');
  await connector.rename('Mac mini');
  expect(rename).toHaveBeenCalledWith('c1', 'Mac mini');
  expect(connector.view().connection?.browserName).toBe('Mac mini');
});
