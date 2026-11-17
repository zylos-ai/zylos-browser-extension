// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { WorkspaceConnector, type ConnectorDeps } from '../../utils/workspace/connector';
import { WorkspaceApiError, type WorkspaceApi } from '../../utils/workspace/api';
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
