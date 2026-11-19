// OpenMax Workspace HTTP client for the browser-extension routes (cws-core).
// Bearer access token from TokenStore; one forced refresh + retry on 401.
import { z } from 'zod';
import { TokenStore, WorkspaceAuthError } from './token-store';

export class WorkspaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceApiError';
  }
}

export const workspaceAgentSchema = z.object({
  agent_member_id: z.string(),
  display_name: z.string(),
  avatar_url: z.string().nullish(),
  authorized: z.boolean(),
  active_connections: z.number().int().default(0),
  /** Absent on servers older than the online-status change: treat as selectable, no status. */
  online: z.boolean().optional(),
});
export type WorkspaceAgent = z.infer<typeof workspaceAgentSchema>;

export const connectionStates = [
  'preparing',
  'ready',
  'connected',
  'failed',
  'revoking',
  'revoked',
] as const;
export const browserConnectionSchema = z.object({
  connection_id: z.string(),
  agent_member_id: z.string(),
  browser_instance_id: z.string(),
  browser_name: z.string(),
  state: z.enum(connectionStates),
  online: z.boolean().default(false),
  key_id: z.string().optional(),
  last_error: z.string().optional(),
});
export type BrowserConnection = z.infer<typeof browserConnectionSchema>;
const connectionDataSchema = z.object({ connection: browserConnectionSchema });
const connectionDetailSchema = connectionDataSchema.extend({
  relay_url: z.string().optional(),
  key: z.string().optional(),
});
export type ConnectionDetail = z.infer<typeof connectionDetailSchema>;

/** 409 from connect/prepare when the chosen Agent is offline. */
export const AGENT_OFFLINE_CODE = 'BROWSER_AGENT_OFFLINE';

export class WorkspaceApi {
  constructor(
    private readonly deps: { tokens: TokenStore; fetch: typeof fetch; baseUrl: () => string },
  ) {}

  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
    const call = (token: string) =>
      this.deps.fetch(`${this.deps.baseUrl()}/api/v1/browser-extension${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
      });
    const token = await this.deps.tokens.accessToken();
    let res: Response;
    try {
      res = await call(token);
      if (res.status === 401) {
        const next = await this.deps.tokens.refresh(token);
        res = await call(next.accessToken);
        if (res.status === 401) {
          await this.deps.tokens.expire();
          throw new WorkspaceAuthError('logged-out', 'access token rejected');
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceAuthError) throw error;
      throw new WorkspaceApiError(0, 'NETWORK', 'Workspace unreachable');
    }
    const json = (await res.json().catch(() => ({}))) as {
      data?: unknown;
      error?: { code?: string; detail?: string; title?: string };
    };
    if (!res.ok)
      throw new WorkspaceApiError(
        res.status,
        json.error?.code || `HTTP_${res.status}`,
        json.error?.detail || json.error?.title || `Workspace request failed (${res.status})`,
      );
    return json.data;
  }

  async listAgents(): Promise<WorkspaceAgent[]> {
    return z.array(workspaceAgentSchema).parse(await this.send('GET', '/agents'));
  }

  async createConnection(input: {
    agentMemberId: string;
    browserInstanceId: string;
    browserName: string;
    confirm: boolean;
  }): Promise<BrowserConnection> {
    const data = await this.send('POST', '/connections', {
      agent_member_id: input.agentMemberId,
      browser_instance_id: input.browserInstanceId,
      browser_name: input.browserName,
      confirm: input.confirm,
    });
    return connectionDataSchema.parse(data).connection;
  }

  async getConnection(id: string): Promise<ConnectionDetail> {
    return connectionDetailSchema.parse(
      await this.send('GET', `/connections/${encodeURIComponent(id)}`),
    );
  }

  async reportConnected(id: string, browserInstanceId: string): Promise<BrowserConnection> {
    const data = await this.send('POST', `/connections/${encodeURIComponent(id)}/connected`, {
      browser_instance_id: browserInstanceId,
    });
    return connectionDataSchema.parse(data).connection;
  }

  async rename(id: string, browserName: string): Promise<BrowserConnection> {
    const data = await this.send('PATCH', `/connections/${encodeURIComponent(id)}`, {
      browser_name: browserName,
    });
    return connectionDataSchema.parse(data).connection;
  }

  async revoke(id: string): Promise<BrowserConnection> {
    const data = await this.send('POST', `/connections/${encodeURIComponent(id)}/revoke`);
    return connectionDataSchema.parse(data).connection;
  }
}
