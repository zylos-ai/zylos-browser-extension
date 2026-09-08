import type { AuthorizationState } from './messages';

// Browser consent only comes from our bundled panel, never an Agent text message.
export class AuthorizationController {
  state: AuthorizationState | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private granting = false;
  constructor(
    private io: {
      publish: () => void;
      send: (message: unknown) => void;
      grant: (windowId: number, check: () => void) => Promise<string>;
      release: () => Promise<unknown>;
    },
  ) {}

  get waiting() {
    return this.state?.status === 'pending' || this.state?.status === 'approving';
  }
  get inFlight() {
    return this.granting;
  }

  receive(request: AuthorizationState) {
    if (request.status === 'pending' && this.state?.id === request.id) return;
    if (request.status !== 'pending' && this.state?.id !== request.id) return;
    // A delayed server acknowledgement must not revive a locally cancelled grant.
    if (
      ['approved', 'resume-failed'].includes(request.status) &&
      ['cancelled', 'denied', 'expired'].includes(this.state?.status || '')
    )
      return;
    const interrupted =
      this.state?.status === 'approving' && !['approved', 'resume-failed'].includes(request.status);
    clearTimeout(this.timer);
    this.revision++;
    this.state = request;
    if (interrupted) void this.io.release();
    if (request.status === 'pending') {
      this.timer = setTimeout(
        () => {
          if (this.state?.id === request.id && this.waiting) this.cancel('expired');
        },
        Math.max(0, request.expiresAt - Date.now()),
      );
    }
    this.io.publish();
  }

  cancel(status: 'cancelled' | 'expired' | 'denied' = 'cancelled') {
    const request = this.state;
    if (!request || (!this.waiting && !['approved', 'resume-failed'].includes(request.status)))
      return;
    const wasGranting = request.status === 'approving';
    clearTimeout(this.timer);
    this.revision++;
    this.state = { ...request, status };
    this.io.send(
      status === 'denied'
        ? { type: 'authorization-decision', id: request.id, approved: false }
        : { type: 'authorization-cancel', id: request.id },
    );
    if (wasGranting) void this.io.release();
    this.io.publish();
  }

  async approve(id: string, windowId: number) {
    const request = this.state;
    if (!request || request.id !== id || request.status !== 'pending' || this.granting)
      throw new Error('该授权请求已处理，请查看最新对话');
    if (Date.now() >= request.expiresAt) {
      this.cancel('expired');
      throw new Error('授权请求已过期，请重新发送需求');
    }
    const revision = this.revision;
    this.granting = true;
    this.state = { ...request, status: 'approving' };
    this.io.publish();
    try {
      const check = () => {
        if (revision !== this.revision || !this.waiting || Date.now() >= request.expiresAt)
          throw new Error('授权请求已取消或过期');
      };
      check();
      const controlSessionId = await this.io.grant(windowId, check);
      if (revision !== this.revision || !this.waiting || Date.now() >= request.expiresAt) {
        await this.io.release();
        throw new Error('授权已取消或过期，未恢复任务');
      }
      // Remain "approving" until the authenticated Channel acknowledges and queues continuation.
      this.io.send({ type: 'authorization-decision', id, approved: true, controlSessionId });
    } catch (error) {
      if (revision === this.revision) {
        this.cancel('denied');
        await this.io.release();
      }
      throw error;
    } finally {
      this.granting = false;
    }
  }
}
