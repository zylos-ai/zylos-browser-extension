// Workspace-mode connection state machine (service worker).
//
// Pick Agent → (confirm, first time only; done in the panel) → name browser →
// create connection → poll until the Agent prepared it → write relay URL + Key
// into the existing remote config (handshake unchanged) → report connected and
// heartbeat. The connection record holds no secret: the Key lives only in the
// existing remote config.
import { z } from 'zod';
import { WorkspaceApi, WorkspaceApiError, type WorkspaceAgent } from './api';
import { WORKSPACE_CONNECTION_KEY } from './config';
import { WorkspaceAuthError, type AuthStatus, type KeyValueStorage } from './token-store';

export const POLL_INTERVAL_MS = 1500;
export const PREPARE_TIMEOUT_MS = 180_000;
export const HEARTBEAT_INTERVAL_MS = 120_000;

export const workspacePhaseSchema = z.enum([
  'idle',
  'preparing',
  'applying',
  'connected',
  'failed',
  'key-rejected',
]);
export type WorkspacePhase = z.infer<typeof workspacePhaseSchema>;

export const connectionRecordSchema = z.object({
  agentMemberId: z.string(),
  agentName: z.string(),
  browserName: z.string(),
  phase: workspacePhaseSchema,
  connectionId: z.string().optional(),
  /** Relay URL the Key was written for; identifies a Workspace-owned remote config. */
  relayUrl: z.string().optional(),
  /** Local keyIdOf() of the written Key (non-secret). */
  localKeyId: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
});
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>;

/** Non-secret view for the side panel. */
export const workspaceViewSchema = z.object({
  baseUrl: z.string(),
  auth: z.enum(['signed-out', 'signed-in', 'expired']),
  busy: z.string().optional(),
  error: z.string().optional(),
  agents: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        avatarUrl: z.string().optional(),
        authorized: z.boolean(),
      }),
    )
    .optional(),
  connection: z
    .object({
      agentMemberId: z.string(),
      agentName: z.string(),
      browserName: z.string(),
      phase: workspacePhaseSchema,
      error: z.string().optional(),
    })
    .optional(),
});
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

export interface ConnectorDeps {
  api: WorkspaceApi;
  storage: KeyValueStorage;
  authStatus: () => Promise<AuthStatus>;
  baseUrl: () => string;
  browserId: () => string;
  /** Persist relay URL + Key through the existing remote config path; returns local key id. */
  applyRelay: (relayUrl: string, key: string) => Promise<string>;
  /** Drop the Workspace-issued Key from the remote config (disconnects). */
  clearRelay: () => Promise<void>;
  /** Whether the remote config currently holds this relay URL + local key id. */
  relayMatches: (relayUrl: string, localKeyId: string) => boolean;
  relayConnected: () => boolean;
  publish: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class WorkspaceConnector {
  private record: ConnectionRecord | undefined;
  private auth: AuthStatus = 'signed-out';
  private agents: WorkspaceAgent[] | undefined;
  private busy: string | undefined;
  private error: string | undefined;
  private run = 0;
  private lastHeartbeat = 0;
  private reported = '';

  constructor(private readonly deps: ConnectorDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private sleep(ms: number) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  async init(): Promise<void> {
    this.auth = await this.deps.authStatus();
    const parsed = connectionRecordSchema.safeParse(
      await this.deps.storage.get(WORKSPACE_CONNECTION_KEY),
    );
    this.record = parsed.success ? parsed.data : undefined;
    // A worker restart during preparation resumes polling the same connection.
    if (this.record?.phase === 'preparing' && this.record.connectionId)
      void this.poll(++this.run, this.record.connectionId);
    if (this.record?.phase === 'applying')
      await this.save({
        ...this.record,
        phase: 'failed',
        error: 'ui.error.workspacePrepareFailed',
      });
  }

  view(): WorkspaceView {
    const r = this.record;
    return {
      baseUrl: this.deps.baseUrl(),
      auth: this.auth,
      ...(this.busy ? { busy: this.busy } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.agents
        ? {
            agents: this.agents.map((a) => ({
              id: a.agent_member_id,
              name: a.display_name,
              ...(a.avatar_url ? { avatarUrl: a.avatar_url } : {}),
              authorized: a.authorized,
            })),
          }
        : {}),
      ...(r
        ? {
            connection: {
              agentMemberId: r.agentMemberId,
              agentName: r.agentName,
              browserName: r.browserName,
              phase: r.phase,
              ...(r.error ? { error: r.error } : {}),
            },
          }
        : {}),
    };
  }

  current(): ConnectionRecord | undefined {
    return this.record;
  }

  /** True when the live remote config is the one this connector wrote. */
  ownsRelay(): boolean {
    const r = this.record;
    return !!(
      r?.relayUrl &&
      r.localKeyId &&
      (r.phase === 'connected' || r.phase === 'applying') &&
      this.deps.relayMatches(r.relayUrl, r.localKeyId)
    );
  }

  async setAuth(status: AuthStatus) {
    this.auth = status;
    if (status !== 'signed-in') this.agents = undefined;
    this.deps.publish();
  }

  private async save(next: ConnectionRecord | undefined) {
    this.record = next;
    if (next) await this.deps.storage.set(WORKSPACE_CONNECTION_KEY, next);
    else await this.deps.storage.remove(WORKSPACE_CONNECTION_KEY);
    this.deps.publish();
  }

  /** Map failures; auth failures move to "Log in again", never touch the relay. */
  private async fail(error: unknown): Promise<string> {
    if (error instanceof WorkspaceAuthError) {
      if (error.kind === 'logged-out') {
        this.auth = await this.deps.authStatus();
        if (this.auth === 'signed-in') this.auth = 'expired';
        this.agents = undefined;
        return 'ui.error.workspaceLoginExpiredError';
      }
      return 'ui.error.workspaceUnreachable';
    }
    if (error instanceof WorkspaceApiError) {
      if (error.status === 0 || error.status >= 500) return 'ui.error.workspaceUnreachable';
      if (error.status === 403) return 'ui.error.workspaceAgentUnavailable';
      if (error.status === 404) return 'ui.error.workspaceAgentNotFound';
      if (error.status === 429) return 'ui.error.workspaceRateLimited';
      return 'ui.error.workspaceRequestFailed';
    }
    if (error instanceof Error && error.message.startsWith('ui.error.')) return error.message;
    return 'ui.error.workspaceRequestFailed';
  }

  async loadAgents(): Promise<void> {
    this.busy = 'agents';
    this.error = undefined;
    this.deps.publish();
    try {
      this.agents = await this.deps.api.listAgents();
    } catch (e) {
      const error = await this.fail(e);
      // Agent-specific wording makes no sense for the list itself.
      this.error =
        error === 'ui.error.workspaceAgentNotFound' ||
        error === 'ui.error.workspaceAgentUnavailable' ||
        error === 'ui.error.workspaceRequestFailed'
          ? 'ui.error.workspaceAgentsLoadFailed'
          : error;
    } finally {
      this.busy = undefined;
      this.deps.publish();
    }
  }

  /**
   * Connect (or switch) to an Agent. Switching just starts a new connection; the
   * previous Agent's authorization is kept server-side.
   */
  async connect(input: {
    agentMemberId: string;
    agentName: string;
    browserName: string;
    confirm: boolean;
  }): Promise<void> {
    const run = ++this.run;
    this.error = undefined;
    const browserName = input.browserName.trim().slice(0, 100);
    if (!browserName) throw new Error('ui.error.workspaceBrowserNameRequired');
    await this.save({
      agentMemberId: input.agentMemberId,
      agentName: input.agentName,
      browserName,
      phase: 'preparing',
      startedAt: this.now(),
    });
    try {
      const connection = await this.deps.api.createConnection({
        agentMemberId: input.agentMemberId,
        browserInstanceId: this.deps.browserId(),
        browserName,
        confirm: input.confirm,
      });
      if (run !== this.run) return;
      await this.save({ ...this.record!, connectionId: connection.connection_id });
      await this.poll(run, connection.connection_id);
    } catch (e) {
      if (run !== this.run) return;
      await this.save({ ...this.record!, phase: 'failed', error: await this.fail(e) });
    }
  }

  /** Reconnect the same Agent after its Key was rejected: no re-confirm. */
  async reconnect(): Promise<void> {
    const r = this.record;
    if (!r) throw new Error('ui.error.workspaceNoConnection');
    await this.connect({
      agentMemberId: r.agentMemberId,
      agentName: r.agentName,
      browserName: r.browserName,
      confirm: false,
    });
  }

  private async poll(run: number, connectionId: string): Promise<void> {
    const started = this.record?.startedAt ?? this.now();
    try {
      for (;;) {
        if (run !== this.run) return;
        const detail = await this.deps.api.getConnection(connectionId);
        if (run !== this.run) return;
        const state = detail.connection.state;
        if ((state === 'ready' || state === 'connected') && detail.relay_url && detail.key) {
          await this.save({ ...this.record!, phase: 'applying' });
          const localKeyId = await this.deps.applyRelay(detail.relay_url, detail.key);
          if (run !== this.run) return;
          this.reported = '';
          await this.save({
            ...this.record!,
            phase: 'connected',
            relayUrl: detail.relay_url,
            localKeyId,
            error: undefined,
          });
          return;
        }
        if (state === 'failed' || state === 'revoking' || state === 'revoked') {
          await this.save({
            ...this.record!,
            phase: 'failed',
            error:
              state === 'failed' ? 'ui.error.workspacePrepareFailed' : 'ui.error.workspaceRevoked',
          });
          return;
        }
        if (this.now() - started > PREPARE_TIMEOUT_MS) {
          await this.save({
            ...this.record!,
            phase: 'failed',
            error: 'ui.error.workspacePrepareTimeout',
          });
          return;
        }
        await this.sleep(POLL_INTERVAL_MS);
      }
    } catch (e) {
      if (run !== this.run) return;
      await this.save({ ...this.record!, phase: 'failed', error: await this.fail(e) });
    }
  }

  /** Relay handshake finished: report connected once per Key, then heartbeat. */
  async onRelayReady(): Promise<void> {
    const r = this.record;
    if (!r?.connectionId || !this.ownsRelay()) return;
    if (this.reported === r.localKeyId) return;
    this.reported = r.localKeyId ?? '';
    await this.report();
  }

  /** Alarm tick: heartbeat while the Workspace-owned relay is connected. */
  async heartbeat(): Promise<void> {
    if (!this.deps.relayConnected() || !this.ownsRelay()) return;
    if (this.now() - this.lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    await this.report();
  }

  private async report() {
    const r = this.record;
    if (!r?.connectionId) return;
    this.lastHeartbeat = this.now();
    try {
      await this.deps.api.reportConnected(r.connectionId, this.deps.browserId());
    } catch (e) {
      // Workspace trouble never disconnects the relay; the Key is independent.
      const error = await this.fail(e);
      if (e instanceof WorkspaceAuthError) this.deps.publish();
      else if (e instanceof WorkspaceApiError && (e.status === 404 || e.status === 403))
        this.error = error;
    }
  }

  /** Relay closed 4004 (Key revoked/expired) or 4003 (Key bound to another browser). */
  async onKeyRejected(code: 4003 | 4004): Promise<void> {
    if (!this.ownsRelay()) return;
    this.run++;
    await this.deps.clearRelay();
    await this.save({
      ...this.record!,
      phase: 'key-rejected',
      relayUrl: undefined,
      localKeyId: undefined,
      error: code === 4003 ? 'ui.error.workspaceKeyElsewhere' : 'ui.error.workspaceKeyRevoked',
    });
  }

  /** Revoke this browser's authorization for the current Agent. */
  async revoke(): Promise<void> {
    const r = this.record;
    if (!r) return;
    this.run++;
    if (r.connectionId) {
      try {
        await this.deps.api.revoke(r.connectionId);
      } catch (e) {
        if (!(e instanceof WorkspaceApiError && e.status === 404)) {
          this.error = await this.fail(e);
          this.deps.publish();
          throw new Error(this.error);
        }
      }
    }
    if (this.ownsRelay()) await this.deps.clearRelay();
    await this.save(undefined);
  }

  /** The owner switched to manual URL + Key: forget the Workspace session locally. */
  async forgetLocal(): Promise<void> {
    this.run++;
    await this.save(undefined);
  }

  /** Explicit sign-out ends the active Workspace session (authorization stays server-side). */
  async signedOut(): Promise<void> {
    this.run++;
    if (this.ownsRelay()) await this.deps.clearRelay();
    this.agents = undefined;
    this.auth = 'signed-out';
    await this.save(undefined);
  }
}
