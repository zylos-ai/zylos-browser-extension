// @vitest-environment node
import { describe, expect, test, vi } from 'vitest';
import {
  PKCE_VERIFIER_RE,
  codeChallengeS256,
  generateCodeVerifier,
  generateState,
} from '../../utils/workspace/pkce';
import {
  REFRESH_SKEW_MS,
  TokenStore,
  WorkspaceAuthError,
  type KeyValueStorage,
} from '../../utils/workspace/token-store';
import { WorkspaceApi } from '../../utils/workspace/api';
import { buildAuthorizeUrl, signIn } from '../../utils/workspace/sign-in';
import {
  WORKSPACE_AUTH_KEY,
  buildWorkspaceUrl,
  normalizeWorkspaceUrl,
  resolveWorkspaceUrl,
  workspaceEnvs,
} from '../../utils/workspace/config';

const BASE = 'https://ws.example';

export function memoryStorage(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  const storage: KeyValueStorage = {
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
  return { storage, data };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Token endpoint with real rotation semantics: a reused refresh token revokes the family. */
function tokenServer() {
  let n = 0;
  let valid = 'r0';
  let revoked = false;
  const calls: string[] = [];
  const handler = vi.fn(async (_url: string, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    calls.push(form.get('refresh_token') ?? '');
    await new Promise((r) => setTimeout(r, 5));
    if (revoked || form.get('refresh_token') !== valid) {
      revoked = true;
      return json(400, { error: 'invalid_grant' });
    }
    n++;
    valid = `r${n}`;
    return json(200, { access_token: `a${n}`, refresh_token: valid, expires_in: 900 });
  });
  return { handler, calls, isRevoked: () => revoked };
}

function signedIn(expiresAt: number, access = 'a0', refresh = 'r0') {
  return {
    [WORKSPACE_AUTH_KEY]: {
      status: 'signed-in',
      baseUrl: BASE,
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
    },
  };
}

describe('PKCE', () => {
  test('verifier is 43 url-safe chars and unique', () => {
    const a = generateCodeVerifier();
    expect(a).toMatch(PKCE_VERIFIER_RE);
    expect(a).toHaveLength(43);
    expect(generateCodeVerifier()).not.toBe(a);
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
  test('S256 challenge matches the RFC 7636 appendix B vector', async () => {
    expect(await codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  test('authorize URL carries client, redirect, state, S256 challenge and scope', async () => {
    const url = new URL(
      await buildAuthorizeUrl(BASE, 'https://x.chromiumapp.org/', 'v'.repeat(43), 's1'),
    );
    expect(url.pathname).toBe('/api/v1/browser-extension/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'openmax-browser',
      redirect_uri: 'https://x.chromiumapp.org/',
      state: 's1',
      code_challenge_method: 'S256',
      scope: 'connect:browser',
    });
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
  });
  test('workspace URL must be an https origin', () => {
    expect(normalizeWorkspaceUrl('https://cws-int.coco.xyz/')).toBe('https://cws-int.coco.xyz');
    expect(normalizeWorkspaceUrl('http://evil.example')).toBeNull();
    expect(normalizeWorkspaceUrl('https://a.example/path')).toBeNull();
    expect(normalizeWorkspaceUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });
});

describe('sign-in', () => {
  test('exchanges the code with the verifier and stores tokens', async () => {
    const { storage, data } = memoryStorage();
    const tokens = new TokenStore({ storage, fetch: vi.fn(), baseUrl: () => BASE });
    let challenge = '';
    const fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('C');
      expect(await codeChallengeS256(form.get('code_verifier')!)).toBe(challenge);
      expect(form.get('client_secret')).toBeNull();
      return json(200, { access_token: 'a', refresh_token: 'r', expires_in: 900 });
    });
    await signIn({
      baseUrl: BASE,
      redirectUri: 'https://x.chromiumapp.org/',
      fetch: fetch as unknown as typeof globalThis.fetch,
      tokens,
      launch: async (url) => {
        const q = new URL(url).searchParams;
        challenge = q.get('code_challenge')!;
        return `https://x.chromiumapp.org/?code=C&state=${q.get('state')}`;
      },
    });
    expect(data.get(WORKSPACE_AUTH_KEY)).toMatchObject({ status: 'signed-in', accessToken: 'a' });
  });
  test('rejects a mismatched state and denial', async () => {
    const { storage } = memoryStorage();
    const tokens = new TokenStore({ storage, fetch: vi.fn(), baseUrl: () => BASE });
    const base = {
      baseUrl: BASE,
      redirectUri: 'https://x.chromiumapp.org/',
      fetch: vi.fn(),
      tokens,
    };
    await expect(
      signIn({ ...base, launch: async () => 'https://x.chromiumapp.org/?code=C&state=wrong' }),
    ).rejects.toThrow('ui.error.workspaceSignInFailed');
    await expect(
      signIn({
        ...base,
        launch: async (u) =>
          `https://x.chromiumapp.org/?error=access_denied&state=${new URL(u).searchParams.get('state')}`,
      }),
    ).rejects.toThrow('ui.error.workspaceSignInDenied');
    await expect(
      signIn({
        ...base,
        launch: async () => {
          throw new Error('The user did not approve access.');
        },
      }),
    ).rejects.toThrow('ui.error.workspaceSignInCancelled');
    await expect(
      signIn({
        ...base,
        launch: async () => {
          throw new Error('Authorization page could not be loaded.');
        },
      }),
    ).rejects.toThrow('ui.error.workspaceSignInUnavailable');
    expect(base.fetch).not.toHaveBeenCalled();
  });
});

describe('token store', () => {
  const now = 1_000_000;
  test('returns the stored token while fresh and refreshes proactively near expiry', async () => {
    const server = tokenServer();
    const { storage } = memoryStorage(signedIn(now + REFRESH_SKEW_MS + 1000));
    let clock = now;
    const store = new TokenStore({
      storage,
      fetch: server.handler as never,
      baseUrl: () => BASE,
      now: () => clock,
    });
    expect(await store.accessToken()).toBe('a0');
    expect(server.handler).not.toHaveBeenCalled();
    clock += 2000; // inside the skew window
    expect(await store.accessToken()).toBe('a1');
    expect(server.calls).toEqual(['r0']);
  });

  test('concurrent callers share one refresh', async () => {
    const server = tokenServer();
    const { storage } = memoryStorage(signedIn(now - 1));
    const store = new TokenStore({
      storage,
      fetch: server.handler as never,
      baseUrl: () => BASE,
      now: () => now,
    });
    const tokens = await Promise.all(Array.from({ length: 8 }, () => store.accessToken()));
    expect(new Set(tokens)).toEqual(new Set(['a1']));
    expect(server.calls).toEqual(['r0']);
    expect(server.isRevoked()).toBe(false);
  });

  test('worker restart: a new instance reads the rotated tokens from storage', async () => {
    const server = tokenServer();
    const { storage } = memoryStorage(signedIn(now - 1));
    const first = new TokenStore({
      storage,
      fetch: server.handler as never,
      baseUrl: () => BASE,
      now: () => now,
    });
    expect(await first.accessToken()).toBe('a1');
    // Worker killed; nothing kept in memory survives.
    const second = new TokenStore({
      storage,
      fetch: server.handler as never,
      baseUrl: () => BASE,
      now: () => now,
    });
    expect(await second.accessToken()).toBe('a1');
    expect(server.calls).toEqual(['r0']);
  });

  test('rotation race: invalid_grant after another context rotated is not a log-out', async () => {
    const { storage, data } = memoryStorage(signedIn(now - 1));
    // Another context (e.g. the previous worker) finishes its refresh while ours is in flight.
    const fetch = vi.fn(async () => {
      data.set(WORKSPACE_AUTH_KEY, {
        status: 'signed-in',
        baseUrl: BASE,
        accessToken: 'aX',
        refreshToken: 'rX',
        expiresAt: now + 900_000,
      });
      return json(400, { error: 'invalid_grant' });
    });
    const store = new TokenStore({
      storage,
      fetch: fetch as never,
      baseUrl: () => BASE,
      now: () => now,
    });
    expect(await store.accessToken()).toBe('aX');
    expect(await store.status()).toBe('signed-in');
  });

  test('invalid_grant with nothing newer stored → expired ("Log in again")', async () => {
    const { storage } = memoryStorage(signedIn(now - 1));
    const onStatus = vi.fn();
    const store = new TokenStore({
      storage,
      fetch: (async () => json(400, { error: 'invalid_grant' })) as never,
      baseUrl: () => BASE,
      now: () => now,
      onStatus,
    });
    await expect(store.accessToken()).rejects.toMatchObject({ kind: 'logged-out' });
    expect(await store.status()).toBe('expired');
    expect(await store.load()).toBeUndefined();
    expect(onStatus).toHaveBeenCalledWith('expired');
  });

  test('network or 5xx failure keeps the session', async () => {
    const { storage } = memoryStorage(signedIn(now - 1));
    const store = new TokenStore({
      storage,
      fetch: (async () => json(503, {})) as never,
      baseUrl: () => BASE,
      now: () => now,
    });
    await expect(store.accessToken()).rejects.toMatchObject({ kind: 'transient' });
    expect(await store.status()).toBe('signed-in');
  });

  test('tokens for a different Workspace URL are ignored', async () => {
    const { storage } = memoryStorage(signedIn(now + 900_000));
    const store = new TokenStore({
      storage,
      fetch: vi.fn(),
      baseUrl: () => 'https://other.example',
      now: () => now,
    });
    await expect(store.accessToken()).rejects.toBeInstanceOf(WorkspaceAuthError);
  });
});

describe('API 401 handling', () => {
  const now = 1_000_000;
  function setup(apiStatuses: number[]) {
    const server = tokenServer();
    const { storage } = memoryStorage(signedIn(now + 900_000));
    const tokens = new TokenStore({
      storage,
      fetch: server.handler as never,
      baseUrl: () => BASE,
      now: () => now,
    });
    const seen: string[] = [];
    const apiFetch = vi.fn(async (_u: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      const status = apiStatuses.shift() ?? 200;
      return status === 200 ? json(200, { data: [] }) : json(status, { error: { code: 'X' } });
    });
    const api = new WorkspaceApi({ tokens, fetch: apiFetch as never, baseUrl: () => BASE });
    return { api, server, seen, tokens };
  }
  test('refreshes once and retries on 401', async () => {
    const { api, server, seen } = setup([401]);
    expect(await api.listAgents()).toEqual([]);
    expect(seen).toEqual(['Bearer a0', 'Bearer a1']);
    expect(server.calls).toEqual(['r0']);
  });
  test('parallel 401s share a single refresh', async () => {
    const { api, server } = setup([401, 401]);
    await Promise.all([api.listAgents(), api.listAgents()]);
    expect(server.calls).toEqual(['r0']);
    expect(server.isRevoked()).toBe(false);
  });
  test('a second 401 after refresh → logged out', async () => {
    const { api, tokens } = setup([401, 401]);
    await expect(api.listAgents()).rejects.toMatchObject({ kind: 'logged-out' });
    expect(await tokens.status()).toBe('expired');
  });
  test('business errors surface status and code', async () => {
    const { api } = setup([404]);
    await expect(api.listAgents()).rejects.toMatchObject({ status: 404, code: 'X' });
  });
});

describe('build-configured workspace environments', () => {
  const envs = JSON.stringify([
    { name: 'INT', url: 'https://cws-int.coco.xyz' },
    { name: 'dev', url: 'https://cws-dev.example' },
  ]);
  test('parses the baked env list; first entry is the default', () => {
    expect(workspaceEnvs(envs).map((e) => e.name)).toEqual(['INT', 'dev']);
    expect(buildWorkspaceUrl(workspaceEnvs(envs))).toBe('https://cws-int.coco.xyz');
    expect(workspaceEnvs(undefined)).toEqual([]);
    expect(workspaceEnvs('not json')).toEqual([]);
    expect(workspaceEnvs(JSON.stringify([{ name: 'x', url: 'http://evil.example' }]))).toEqual([]);
  });
  test('a stored URL outside the build allow-list falls back to the build default', () => {
    const release = workspaceEnvs(JSON.stringify([{ name: '', url: 'https://ws.example' }]));
    expect(resolveWorkspaceUrl('https://cws-int.coco.xyz', release)).toBe('https://ws.example');
    expect(resolveWorkspaceUrl('https://custom.example', release)).toBe('https://ws.example');
    expect(resolveWorkspaceUrl(undefined, release)).toBe('https://ws.example');
    expect(resolveWorkspaceUrl('https://cws-dev.example/', workspaceEnvs(envs))).toBe(
      'https://cws-dev.example',
    );
  });
});
