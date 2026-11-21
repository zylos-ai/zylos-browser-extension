// OpenMax Workspace sign-in tokens. Service-worker only: tokens live in
// chrome.storage.local (TRUSTED_CONTEXTS), are never logged and never sent to
// pages, content scripts or the side panel.
//
// MV3 workers can be killed at any moment, so nothing important is kept only in
// memory: every call re-reads storage. Refresh tokens rotate on every use and a
// reused one revokes the whole sign-in, so refreshes are single-flight within
// the worker (one shared promise, plus a Web Lock when available) and an
// invalid_grant is re-checked against storage before declaring logged-out.
import { z } from 'zod';
import { WORKSPACE_AUTH_KEY, WORKSPACE_CLIENT_ID } from './config';

/** Refresh this long before expiry so requests never race the deadline. */
export const REFRESH_SKEW_MS = 60_000;

export const storedTokensSchema = z.object({
  baseUrl: z.string(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  orgId: z.string().optional(),
  memberId: z.string().optional(),
});
export type StoredTokens = z.infer<typeof storedTokensSchema>;
const storedAuthSchema = z.union([
  storedTokensSchema.extend({ status: z.literal('signed-in') }),
  z.object({ status: z.literal('expired'), baseUrl: z.string() }),
]);
export type AuthStatus = 'signed-out' | 'signed-in' | 'expired';

export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export const chromeLocalStorage: KeyValueStorage = {
  async get(key) {
    return (await chrome.storage.local.get([key]))[key];
  },
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: (key) => chrome.storage.local.remove(key),
};

export class WorkspaceAuthError extends Error {
  constructor(
    /** logged-out: sign in again; transient: network/server, keep the session. */
    readonly kind: 'logged-out' | 'transient',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceAuthError';
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  org_id?: string;
  member_id?: string;
}

type LockFn = <T>(name: string, run: () => Promise<T>) => Promise<T>;
const webLock: LockFn | undefined =
  typeof navigator !== 'undefined' && navigator.locks
    ? <T>(name: string, run: () => Promise<T>) =>
        navigator.locks.request(name, run) as unknown as Promise<T>
    : undefined;

export class TokenStore {
  private inflight: Promise<StoredTokens> | null = null;
  constructor(
    private readonly deps: {
      storage: KeyValueStorage;
      fetch: typeof fetch;
      baseUrl: () => string;
      now?: () => number;
      lock?: LockFn;
      onStatus?: (status: AuthStatus) => void;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** Current tokens for the configured Workspace, or undefined. */
  async load(): Promise<StoredTokens | undefined> {
    const parsed = storedAuthSchema.safeParse(await this.deps.storage.get(WORKSPACE_AUTH_KEY));
    if (!parsed.success || parsed.data.status !== 'signed-in') return undefined;
    if (parsed.data.baseUrl !== this.deps.baseUrl()) return undefined;
    const { status: _status, ...tokens } = parsed.data;
    return tokens;
  }

  async status(): Promise<AuthStatus> {
    const parsed = storedAuthSchema.safeParse(await this.deps.storage.get(WORKSPACE_AUTH_KEY));
    if (!parsed.success || parsed.data.baseUrl !== this.deps.baseUrl()) return 'signed-out';
    return parsed.data.status;
  }

  async save(response: TokenResponse): Promise<StoredTokens> {
    const tokens = tokensFromResponse(response, this.deps.baseUrl(), this.now());
    await this.deps.storage.set(WORKSPACE_AUTH_KEY, { status: 'signed-in', ...tokens });
    this.deps.onStatus?.('signed-in');
    return tokens;
  }

  /** Explicit sign-out: forget everything. */
  async clear(): Promise<void> {
    await this.deps.storage.remove(WORKSPACE_AUTH_KEY);
    this.deps.onStatus?.('signed-out');
  }

  /** The sign-in is no longer valid: keep a marker so the UI says "Log in again". */
  async expire(): Promise<void> {
    await this.deps.storage.set(WORKSPACE_AUTH_KEY, {
      status: 'expired',
      baseUrl: this.deps.baseUrl(),
    });
    this.deps.onStatus?.('expired');
  }

  /** A usable access token; refreshes proactively when close to expiry. */
  async accessToken(): Promise<string> {
    const tokens = await this.load();
    if (!tokens) throw new WorkspaceAuthError('logged-out', 'not signed in');
    if (tokens.expiresAt - this.now() > REFRESH_SKEW_MS) return tokens.accessToken;
    return (await this.refresh()).accessToken;
  }

  /**
   * Single-flight refresh. `rejectedAccessToken` is the token a 401 came back
   * for: if storage already holds a different, unexpired one, another caller
   * refreshed meanwhile and no new refresh is spent.
   */
  refresh(rejectedAccessToken?: string): Promise<StoredTokens> {
    if (!this.inflight) {
      const lock = this.deps.lock ?? webLock;
      const run = () => this.refreshOnce(rejectedAccessToken);
      this.inflight = (lock ? lock('openmax-workspace-refresh', run) : run()).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refreshOnce(rejectedAccessToken?: string): Promise<StoredTokens> {
    const current = await this.load();
    if (!current) throw new WorkspaceAuthError('logged-out', 'not signed in');
    const fresh = current.expiresAt - this.now() > REFRESH_SKEW_MS;
    if (fresh && (rejectedAccessToken === undefined || rejectedAccessToken !== current.accessToken))
      return current;
    let res: Response;
    try {
      res = await this.deps.fetch(`${current.baseUrl}/api/v1/browser-extension/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          client_id: WORKSPACE_CLIENT_ID,
        }),
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      throw new WorkspaceAuthError('transient', 'token refresh failed: network');
    }
    const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & {
      error?: string;
    };
    if (res.ok && body.access_token && body.refresh_token) return this.save(body as TokenResponse);
    if (res.status === 400 && body.error === 'invalid_grant') {
      // Rotation race: another context may have used this refresh token
      // successfully and stored its successor. Only that is not a log-out.
      const latest = await this.load();
      if (latest && latest.refreshToken !== current.refreshToken) return latest;
      await this.expire();
      throw new WorkspaceAuthError('logged-out', 'sign-in expired');
    }
    if (res.status === 400 || res.status === 401) {
      await this.expire();
      throw new WorkspaceAuthError(
        'logged-out',
        `token refresh refused: ${body.error ?? res.status}`,
      );
    }
    throw new WorkspaceAuthError('transient', `token refresh failed: ${res.status}`);
  }
}

export function tokensFromResponse(
  response: TokenResponse,
  baseUrl: string,
  now: number,
): StoredTokens {
  if (!response.access_token || !response.refresh_token)
    throw new WorkspaceAuthError('logged-out', 'token response incomplete');
  const ttl =
    Number.isFinite(response.expires_in) && response.expires_in > 0 ? response.expires_in : 900;
  return {
    baseUrl,
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: now + ttl * 1000,
    ...(response.org_id ? { orgId: response.org_id } : {}),
    ...(response.member_id ? { memberId: response.member_id } : {}),
  };
}
