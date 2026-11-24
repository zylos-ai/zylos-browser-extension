// Workspace-mode connection state machine (service worker).
//
// Pick Agent → (confirm, first time only; done in the panel) → name browser →
// create connection → poll until the Agent prepared it → write relay URL + Key
// into the existing remote config (handshake unchanged) → report connected and
// heartbeat. The connection record holds no secret: the Key lives only in the
// existing remote config.
import { z } from 'zod';
import {
  AGENT_OFFLINE_CODE,
  AGENT_STATUS_UNAVAILABLE_CODE,
  WorkspaceApi,
  WorkspaceApiError,
  type WorkspaceAgent,
} from './api';
import { WORKSPACE_CONNECTION_KEY } from './config';
import { WorkspaceAuthError, type AuthStatus, type KeyValueStorage } from './token-store';

export const POLL_INTERVAL_MS = 1500;
/**
 * Bounded wait for the Agent to prepare. An online Agent usually mints the relay
 * Key in seconds, but on first use it may first install/upgrade browser-remote
 * (zylos add/upgrade, up to 180s) and verify it is running (up to 60s). 300s
 * covers that and matches the server-side prepare timeout (5 min; never longer).
 */
export const PREPARE_TIMEOUT_MS = 300_000;

/** Known Agent-side prepare errors (connection.last_error) → specific copy. */
export function prepareErrorKey(lastError: string | undefined): string {
  const e = lastError ?? '';
  if (/browser-remote is too old/i.test(e)) return 'ui.error.workspaceAgentBrowserRemoteOld';
  if (/not a valid http\(s\) URL/i.test(e)) return 'ui.error.workspaceAgentPublicUrlInvalid';
  if (/no public domain|AGENT_PUBLIC_BASE_URL/i.test(e))
    return 'ui.error.workspaceAgentNoPublicUrl';
  return 'ui.error.workspacePrepareFailed';
}

declare const __WORKSPACE_LOOPBACK_RELAY__: boolean;
/** Build-time: dev/test builds also accept ws:// loopback relays; release builds do not. */
export const LOOPBACK_RELAY_ALLOWED: boolean =
  typeof __WORKSPACE_LOOPBACK_RELAY__ === 'undefined' ? true : __WORKSPACE_LOOPBACK_RELAY__;

/** Workspace-issued Keys only travel over TLS (ws:// loopback only in dev/test builds). */
export function isSecureRelayUrl(value: string, allowLoopback = LOOPBACK_RELAY_ALLOWED): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'wss:') return true;
    return (
      allowLoopback &&
      url.protocol === 'ws:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}
/**
 * The relay write as queued behind panel mutations: skipped when the Workspace
 * run was superseded while queued (e.g. a manual save ahead of it).
 */
export function queuedRelayWrite(
  mutate: <T>(run: () => Promise<T>) => Promise<T>,
  saveConnection: (relayUrl: string, key: string) => Promise<unknown>,
  keyId: () => string,
): ConnectorDeps['applyRelay'] {
  return (relayUrl, key, isCurrent) =>
    mutate(async () => {
      if (!isCurrent()) return undefined;
      await saveConnection(relayUrl, key);
      return keyId();
    });
}

/**
 * The relay clear as queued behind panel mutations: the Key is dropped only if
 * the remote config still holds exactly this relay URL + key id when the queued
 * clear runs, so a manual save (or another Workspace session's Key) queued
 * ahead of it is never cleared.
 */
export function queuedRelayClear(
  mutate: <T>(run: () => Promise<T>) => Promise<T>,
  clearKey: (relayUrl: string) => Promise<unknown>,
  relayMatches: ConnectorDeps['relayMatches'],
): ConnectorDeps['clearRelay'] {
  return (relayUrl, localKeyId) =>
    mutate(async () => {
      if (!relayMatches(relayUrl, localKeyId)) return;
      await clearKey(relayUrl);
    });
}

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
        /** Omitted when the server does not report presence (old server). */
        status: z.enum(['online', 'offline', 'unknown']).optional(),
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
  /**
   * Persist relay URL + Key through the existing remote config path; returns the
   * local key id, or undefined when `isCurrent()` turned false before the write
   * (superseded, e.g. by a manual save queued ahead of it).
   */
  applyRelay: (
    relayUrl: string,
    key: string,
    isCurrent: () => boolean,
  ) => Promise<string | undefined>;
  /** Local key id the remote config will report for this Key (keyIdOf). */
  keyIdOf: (key: string) => Promise<string>;
  /**
   * Drop the Workspace-issued Key from the remote config (disconnects), only if
   * it still holds this relay URL + local key id when the queued clear runs.
   */
  clearRelay: (relayUrl: string, localKeyId: string) => Promise<void>;
  /** Whether the remote config currently holds this relay URL + local key id. */
  relayMatches: (relayUrl: string, localKeyId: string) => boolean;
  relayConnected: () => boolean;
  /** A rename succeeded; the relay may be told the new name (old relays ignore it). */
  onBrowserName?: (browserName: string) => void;
  publish: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * A user label, sent to the relay as untrusted display text: control characters
 * become spaces and truncation never splits a surrogate pair.
 */
export function cleanBrowserName(input: string) {
  // eslint-disable-next-line no-control-regex
  const flat = input.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return Array.from(flat).slice(0, 100).join('').trim();
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
  /** Wakes the current poll sleep early (cancel) and clears its timer. */
  private wake: (() => void) | undefined;

  constructor(private readonly deps: ConnectorDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private sleep(ms: number) {
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }

  /** Invalidate any in-flight connect/poll and stop its pending timer. */
  private stopRun() {
    this.run++;
    this.wake?.();
  }

  /** Best-effort server-side abandon of a pending connection. */
  private async abandon(connectionId: string | undefined) {
    if (!connectionId) return;
    await this.deps.api.revoke(connectionId).catch(() => {});
  }

  async init(): Promise<void> {
    this.auth = await this.deps.authStatus();
    const parsed = connectionRecordSchema.safeParse(
      await this.deps.storage.get(WORKSPACE_CONNECTION_KEY),
    );
    this.record = parsed.success ? parsed.data : undefined;
    // A worker restart during preparation resumes polling the same connection.
    if (this.record?.phase === 'preparing' && this.record.connectionId) {
      this.stopRun();
      void this.poll(this.run, this.record.connectionId);
    }
    if (this.record?.phase === 'applying') {
      // The worker died between writing the relay and saving "connected": the
      // Key may already be in the remote config without a record owning it.
      // Only that exact Key is cleared (URL + key id): a manual config is never touched.
      if (
        this.record.relayUrl &&
        this.record.localKeyId &&
        this.deps.relayMatches(this.record.relayUrl, this.record.localKeyId)
      )
        await this.deps.clearRelay(this.record.relayUrl, this.record.localKeyId).catch(() => {});
      await this.save({
        ...this.record,
        phase: 'failed',
        relayUrl: undefined,
        localKeyId: undefined,
        error: 'ui.error.workspacePrepareFailed',
      });
    }
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
              ...(a.online_status ? { status: a.online_status } : {}),
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

  /** Trimmed browser name to report to the relay, only for a Workspace-owned relay. */
  relayBrowserName(): string | undefined {
    if (!this.ownsRelay()) return undefined;
    return cleanBrowserName(this.record!.browserName) || undefined;
  }

  /** Rename this browser in Workspace, then tell the relay. */
  async rename(input: string) {
    const browserName = cleanBrowserName(input);
    if (!browserName) throw new Error('ui.error.workspaceBrowserNameRequired');
    const record = this.record;
    if (!record?.connectionId) return;
    await this.deps.api.rename(record.connectionId, browserName);
    if (this.record !== record) return;
    await this.save({ ...record, browserName });
    if (this.ownsRelay()) this.deps.onBrowserName?.(browserName);
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
      if (error.code === AGENT_OFFLINE_CODE) return 'ui.error.workspaceAgentOffline';
      if (error.code === AGENT_STATUS_UNAVAILABLE_CODE)
        return 'ui.error.workspaceAgentStatusUnavailable';
      if (error.status === 0 || error.status >= 500) return 'ui.error.workspaceUnreachable';
      if (error.status === 403) return 'ui.error.workspaceAgentUnavailable';
      if (error.status === 404) return 'ui.error.workspaceAgentNotFound';
      if (error.status === 429) return 'ui.error.workspaceRateLimited';
      return 'ui.error.workspaceRequestFailed';
    }
    if (error instanceof Error && error.message.startsWith('ui.error.')) return error.message;
    return 'ui.error.workspaceRequestFailed';
  }

  async loadAgents(keepError = false): Promise<void> {
    this.busy = 'agents';
    if (!keepError) this.error = undefined;
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
   * Connect (or switch) to an Agent. Switching ends the current session first:
   * the previous Workspace-issued Key is cleared from the remote config before
   * the new attempt replaces the record, so a failed/cancelled switch never
   * leaves an unowned Key applied. The previous Agent's authorization is kept
   * server-side.
   */
  async connect(input: {
    agentMemberId: string;
    agentName: string;
    browserName: string;
    confirm: boolean;
  }): Promise<void> {
    this.stopRun();
    const run = this.run;
    this.error = undefined;
    const browserName = input.browserName.trim().slice(0, 100);
    if (!browserName) throw new Error('ui.error.workspaceBrowserNameRequired');
    const previous = this.record;
    if (this.ownsRelay()) {
      try {
        await this.deps.clearRelay(previous!.relayUrl!, previous!.localKeyId!);
      } catch {
        // The current session stays as it was (it still owns its Key); say why
        // the switch did not start instead of failing silently.
        if (run !== this.run) return;
        this.error = 'ui.error.workspaceSwitchClearFailed';
        this.deps.publish();
        return;
      }
    }
    // A previous attempt still preparing is abandoned server-side.
    if (previous?.phase === 'preparing') void this.abandon(previous.connectionId);
    if (run !== this.run) return;
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
      // Cancelled while the create was in flight: abandon the orphan server-side.
      if (run !== this.run) return void (await this.abandon(connection.connection_id));
      await this.save({ ...this.record!, connectionId: connection.connection_id });
      await this.poll(run, connection.connection_id);
    } catch (e) {
      if (run !== this.run) return;
      await this.failed(e);
    }
  }

  /** Failure while connecting; an offline Agent goes back to a refreshed picker. */
  private async failed(e: unknown) {
    const error = await this.fail(e);
    if (error === 'ui.error.workspaceAgentOffline') {
      this.error = error;
      await this.save(undefined);
      await this.loadAgents(true);
      return;
    }
    // Presence could not be checked: back to the same picker (list kept), Retry offered.
    if (error === 'ui.error.workspaceAgentStatusUnavailable') {
      this.error = error;
      await this.save(undefined);
      return;
    }
    await this.save({ ...this.record!, phase: 'failed', error });
  }

  /**
   * Cancel while preparing: stop polling, abandon the pending connection
   * server-side (revoke) and return to the picker. A late "ready" from the
   * cancelled attempt is dropped by the run check, so it never writes the relay.
   */
  async cancel(): Promise<void> {
    const r = this.record;
    if (!r || (r.phase !== 'preparing' && r.phase !== 'idle')) return;
    this.stopRun();
    this.error = undefined;
    await this.save(undefined);
    await this.abandon(r.connectionId);
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
          if (!isSecureRelayUrl(detail.relay_url)) {
            void this.abandon(connectionId);
            await this.save({
              ...this.record!,
              phase: 'failed',
              error: 'ui.error.workspaceRelayInsecure',
            });
            return;
          }
          // relayUrl + key id are recorded before the write so a worker restart
          // (or a sign-out/revoke/switch mid-write) can find and clear exactly
          // this Key even though "connected" was never saved.
          const expectedKeyId = await this.deps.keyIdOf(detail.key.trim());
          if (run !== this.run) return;
          await this.save({
            ...this.record!,
            phase: 'applying',
            relayUrl: detail.relay_url,
            localKeyId: expectedKeyId,
          });
          // Cancelled during the save: a late "ready" must not write relay settings.
          if (run !== this.run) return;
          const localKeyId = await this.deps.applyRelay(
            detail.relay_url,
            detail.key,
            () => run === this.run,
          );
          if (run !== this.run || localKeyId === undefined) {
            // Superseded after the write landed (sign-out/revoke/switch mid-write):
            // the Key just written belongs to no record, so clear it. clearRelay
            // re-checks URL + key id when the queued clear runs, so a manual save
            // or another session's Key that landed in between is left untouched.
            if (run !== this.run && localKeyId !== undefined)
              await this.deps.clearRelay(detail.relay_url, localKeyId).catch(() => {});
            return;
          }
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
              state === 'failed'
                ? prepareErrorKey(detail.connection.last_error)
                : 'ui.error.workspaceRevoked',
          });
          return;
        }
        if (this.now() - started > PREPARE_TIMEOUT_MS) {
          void this.abandon(connectionId);
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
      await this.failed(e);
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
    this.stopRun();
    await this.deps.clearRelay(this.record!.relayUrl!, this.record!.localKeyId!);
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
    this.stopRun();
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
    if (this.ownsRelay()) await this.deps.clearRelay(r.relayUrl!, r.localKeyId!);
    await this.save(undefined);
  }

  /** The owner switched to manual URL + Key: forget the Workspace session locally. */
  async forgetLocal(): Promise<void> {
    this.stopRun();
    await this.save(undefined);
  }

  /** Explicit sign-out ends the active Workspace session (authorization stays server-side). */
  async signedOut(): Promise<void> {
    this.stopRun();
    const r = this.record;
    if (this.ownsRelay()) await this.deps.clearRelay(r!.relayUrl!, r!.localKeyId!);
    this.agents = undefined;
    this.auth = 'signed-out';
    await this.save(undefined);
  }
}
