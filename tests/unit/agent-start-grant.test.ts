// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_START_GRANT_KEY,
  agentStartBinding,
  agentStartGrantLive,
  clearAgentStartGrant,
  createAgentStartGrant,
  loadAgentStartGrant,
  restorableAgentStartGrant,
  saveAgentStartGrant,
} from '../../utils/agent-start-grant';
import { remoteRequestSchema } from '../../utils/remote';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const BINDING = agentStartBinding('wss://relay.example/ext', 'abababababab');
let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) =>
          Object.fromEntries(keys.filter((k) => k in storage).map((k) => [k, storage[k]])),
        ),
        set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storage, value)),
        remove: vi.fn(async (key: string) => {
          delete storage[key];
        }),
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('agent-start grant', () => {
  it('binds to relay URL and keyId only', () => {
    expect(BINDING).toBe('wss://relay.example/ext|abababababab');
    expect(agentStartBinding('', 'abababababab')).toBe('');
    expect(agentStartBinding('wss://relay.example/ext', '')).toBe('');
  });

  it('defaults to seven days and supports one day, thirty days and permanent', () => {
    expect(createAgentStartGrant(BINDING, undefined, NOW).expiresAt).toBe(NOW + 7 * DAY);
    expect(createAgentStartGrant(BINDING, 1440, NOW).expiresAt).toBe(NOW + DAY);
    expect(createAgentStartGrant(BINDING, 43200, NOW).expiresAt).toBe(NOW + 30 * DAY);
    expect(createAgentStartGrant(BINDING, null, NOW)).toEqual({
      binding: BINDING,
      grantedAt: NOW,
      expiresAt: null,
    });
    expect(() => createAgentStartGrant(BINDING, 43201, NOW)).toThrow();
    expect(() => createAgentStartGrant('', 1440, NOW)).toThrow();
  });

  it('is live only between grant time and expiry', () => {
    const grant = createAgentStartGrant(BINDING, 1440, NOW);
    expect(agentStartGrantLive(grant, NOW)).toBe(true);
    expect(agentStartGrantLive(grant, NOW + DAY - 1)).toBe(true);
    expect(agentStartGrantLive(grant, NOW + DAY)).toBe(false);
    // Clock rollback before the grant does not keep a permissive grant alive.
    expect(agentStartGrantLive(grant, NOW - 1)).toBe(false);
    expect(agentStartGrantLive(createAgentStartGrant(BINDING, null, NOW), NOW + 365 * DAY)).toBe(
      true,
    );
    expect(agentStartGrantLive(undefined, NOW)).toBe(false);
  });

  it('restores only valid grants for the same binding', () => {
    const grant = createAgentStartGrant(BINDING, 1440, NOW);
    expect(restorableAgentStartGrant(grant, BINDING, NOW + 1)).toEqual(grant);
    expect(restorableAgentStartGrant(grant, `${BINDING}x`, NOW + 1)).toBeUndefined();
    expect(restorableAgentStartGrant(grant, '', NOW + 1)).toBeUndefined();
    expect(restorableAgentStartGrant(grant, BINDING, NOW + DAY)).toBeUndefined();
    expect(restorableAgentStartGrant(grant, BINDING, NOW - 1)).toBeUndefined();
    expect(restorableAgentStartGrant({ ...grant, extra: 1 }, BINDING, NOW)).toBeUndefined();
    expect(
      restorableAgentStartGrant({ ...grant, expiresAt: NOW + 31 * DAY }, BINDING, NOW),
    ).toBeUndefined();
    expect(restorableAgentStartGrant({ ...grant, expiresAt: NOW }, BINDING, NOW)).toBeUndefined();
    expect(restorableAgentStartGrant(null, BINDING, NOW)).toBeUndefined();
  });

  it('saves, loads and clears the durable record', async () => {
    const grant = createAgentStartGrant(BINDING, null, NOW);
    await saveAgentStartGrant(grant);
    expect(storage[AGENT_START_GRANT_KEY]).toEqual(grant);
    expect(await loadAgentStartGrant(BINDING, NOW + DAY)).toEqual(grant);
    await clearAgentStartGrant();
    expect(AGENT_START_GRANT_KEY in storage).toBe(false);
    expect(await loadAgentStartGrant(BINDING, NOW)).toBeUndefined();
  });

  it('removes expired or mismatched records when loading', async () => {
    await saveAgentStartGrant(createAgentStartGrant(BINDING, 1440, NOW));
    expect(await loadAgentStartGrant(BINDING, NOW + DAY)).toBeUndefined();
    expect(AGENT_START_GRANT_KEY in storage).toBe(false);
    await saveAgentStartGrant(createAgentStartGrant(BINDING, null, NOW));
    expect(await loadAgentStartGrant('wss://other.example/ext|abababababab', NOW)).toBeUndefined();
    expect(AGENT_START_GRANT_KEY in storage).toBe(false);
  });

  it('panel requests accept the site-rule duration encoding and stay compatible', () => {
    const parse = (value: unknown) => remoteRequestSchema.safeParse(value).success;
    expect(parse({ type: 'remote-agent-start-set-enabled', enabled: true })).toBe(true);
    expect(parse({ type: 'remote-agent-start-set-enabled', enabled: false })).toBe(true);
    for (const durationMinutes of [1440, 10080, 43200, null])
      expect(
        parse({ type: 'remote-agent-start-set-enabled', enabled: true, durationMinutes }),
      ).toBe(true);
    for (const durationMinutes of [43201, 0, 1.5, '7'])
      expect(
        parse({ type: 'remote-agent-start-set-enabled', enabled: true, durationMinutes }),
      ).toBe(false);
  });
});
