export const SHARE_TTL = 120_000;
export const SHARE_BYTES = 2 * 1024 * 1024;
export type ShareContext = {
  consent: string;
  expiresAt: number;
  generation: number;
  recipient: string;
  connected: boolean;
};
export type SharePhase = 'idle' | 'prepared' | 'authorized' | 'consumed' | 'expired' | 'revoked';

/** A grant owns one immutable preview, never a subscription to future records. */
export class DetailedSharing {
  private phase: SharePhase = 'idle';
  private expiry = 0;
  constructor(private changed: () => void = () => {}) {}
  state() {
    return { phase: this.phase, expiresAt: this.expiry };
  }
  private timer?: ReturnType<typeof setTimeout>;
  private prepared?: {
    id: string;
    text: string;
    sha256: string;
    context: ShareContext;
    expiresAt: number;
    granted: boolean;
  };
  revoke(phase: SharePhase = this.expiry && Date.now() >= this.expiry ? 'expired' : 'revoked') {
    clearTimeout(this.timer);
    this.prepared = undefined;
    this.phase = phase;
    this.changed();
  }
  private allowed(context: ShareContext) {
    return (
      context.connected &&
      !!context.consent &&
      Date.now() < context.expiresAt &&
      new URL(context.recipient).protocol === 'wss:'
    );
  }
  private matches(context: ShareContext) {
    const item = this.prepared;
    return (
      item &&
      this.allowed(context) &&
      Date.now() < item.expiresAt &&
      item.context.consent === context.consent &&
      item.context.generation === context.generation &&
      item.context.recipient === context.recipient
    );
  }
  async prepare(snapshot: unknown, context: ShareContext) {
    this.revoke();
    if (!this.allowed(context)) throw new Error('ui.error.detailedExpired');
    const text = JSON.stringify(snapshot, null, 2);
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > SHARE_BYTES) throw new Error('ui.error.detailedExpired');
    const item = {
      id: crypto.randomUUID(),
      text,
      sha256: '',
      context: { ...context },
      expiresAt: Math.min(context.expiresAt, Date.now() + SHARE_TTL),
      granted: false,
    };
    this.prepared = item;
    this.expiry = item.expiresAt;
    this.timer = setTimeout(() => this.revoke('expired'), item.expiresAt - Date.now());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    if (this.prepared !== item) throw new Error('ui.error.detailedExpired');
    item.sha256 = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join(
      '',
    );
    this.phase = 'prepared';
    this.changed();
    return {
      id: item.id,
      text,
      sha256: item.sha256,
      expiresAt: item.expiresAt,
      recipient: new URL(context.recipient).origin,
    };
  }
  grant(id: string, context: ShareContext) {
    if (
      !this.matches(context) ||
      this.prepared!.id !== id ||
      !this.prepared!.sha256 ||
      this.prepared!.granted
    )
      throw new Error('ui.error.detailedExpired');
    this.prepared!.granted = true;
    this.phase = 'authorized';
    this.changed();
    return { expiresAt: this.prepared!.expiresAt };
  }
  fetch(context: ShareContext) {
    if (!this.matches(context)) {
      if (this.prepared) this.revoke();
      throw new Error('DETAIL_SHARE_UNAVAILABLE');
    }
    if (!this.prepared!.granted) throw new Error('DETAIL_SHARE_UNAVAILABLE');
    const { text, sha256 } = this.prepared!;
    this.revoke('consumed'); // Consume before transport: retries must never receive a second copy.
    return { schemaVersion: 1 as const, text, sha256 };
  }
}
