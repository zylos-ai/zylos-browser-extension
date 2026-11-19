// @vitest-environment node
import { expect, test, vi } from 'vitest';
import {
  POLL_INTERVAL_MS,
  PREPARE_TIMEOUT_MS,
  WorkspaceConnector,
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
    applyRelay: vi.fn(async (url: string, key: string) => {
      relay.url = url;
      relay.key = key;
      return `kid-${key}`;
    }),
    clearRelay: vi.fn(async () => {
      relay.key = '';
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
  expect(deps.applyRelay).toHaveBeenCalledWith('wss://relay/ext', 'abc');
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
  expect(deps.applyRelay).toHaveBeenCalledWith('wss://r', 'k1');
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

test('preparing is bounded at 90s: then failed (timeout) and the connection is abandoned', async () => {
  expect(PREPARE_TIMEOUT_MS).toBe(90_000);
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
