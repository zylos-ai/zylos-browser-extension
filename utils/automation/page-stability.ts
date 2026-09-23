export type PageProbe = {
  signature: string;
  busy: boolean;
  atBoundary: boolean;
  limited: boolean;
  frames: string[];
  scroll?: {
    x: number;
    y: number;
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
  };
};

// Keep only request identities/times, never headers, URLs or response bodies.
export class NetworkActivity {
  private pending = new Map<string, { frame: string; started: number }>();
  private activity = new Map<string, number>();
  clear() {
    this.pending.clear();
    this.activity.clear();
  }
  event(session: string, method: string, params: any, now = Date.now()) {
    const key = `${session}:${params?.requestId}`;
    if (method === 'Network.requestWillBeSent') {
      if (!['Document', 'XHR', 'Fetch', 'Script'].includes(params.type)) return;
      if (this.pending.size >= 500) this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(key, { frame: params.frameId, started: now });
      this.touch(params.frameId, now);
    } else if (['Network.loadingFinished', 'Network.loadingFailed'].includes(method)) {
      const request = this.pending.get(key);
      if (request) this.touch(request.frame, now);
      this.pending.delete(key);
    } else if (method === 'Network.responseReceived' && params.type === 'EventSource') {
      this.pending.delete(key);
    }
  }
  private touch(frame: string, now: number) {
    this.activity.set(frame, now);
    if (this.activity.size > 100) this.activity.delete(this.activity.keys().next().value!);
  }
  sample(frames: string[], now = Date.now()) {
    let pending = 0,
      lastActivity = 0;
    for (const [key, request] of this.pending) {
      if (now - request.started > 30_000) this.pending.delete(key);
      else if (frames.includes(request.frame)) pending++;
    }
    for (const frame of frames)
      lastActivity = Math.max(lastActivity, this.activity.get(frame) || 0);
    return { pending, lastActivity };
  }
}

export async function waitForStablePage(io: {
  probe(): Promise<PageProbe>;
  network(frames: string[]): { pending: number; lastActivity: number };
  check(): void;
  timeoutMs: number;
  // A deliberate re-observation gets a grace period even before a delayed request starts.
  minWaitMs?: number;
  boundaryGrace?: boolean;
}) {
  const started = Date.now();
  let lastSignature: string | undefined,
    quietSince = started;
  let last: PageProbe | undefined;
  let network = { pending: 0, lastActivity: 0 };
  let changed = false;
  for (;;) {
    io.check();
    last = await io.probe();
    io.check();
    if (last.signature !== lastSignature) {
      if (lastSignature !== undefined) changed = true;
      lastSignature = last.signature;
      quietSince = Date.now();
    }
    network = io.network(last.frames);
    const now = Date.now();
    const minimum = Math.max(io.minWaitMs ?? 350, io.boundaryGrace && last.atBoundary ? 1200 : 0);
    const stable =
      !last.busy &&
      network.pending === 0 &&
      now - Math.max(quietSince, network.lastActivity) >= 350 &&
      now - started >= minimum;
    if (stable || now - started >= io.timeoutMs) {
      return {
        status: stable && !last.limited ? 'stable' : stable ? 'partial' : 'loading',
        durationMs: now - started,
        contentChangedDuringWait: changed,
        pendingRequests: network.pending,
        busy: last.busy,
        probeLimited: last.limited,
        ...(last.scroll ? { scroll: last.scroll } : {}),
        // A geometric edge is evidence about this instant, not dataset completeness.
        atBoundary: last.atBoundary,
        endOfContent: 'unconfirmed',
        note: stable
          ? 'Observed state settled within the sampling budget. A boundary does not prove all results are loaded.'
          : 'Content may still be loading. Use wait-for-page to re-observe; do not replay completed input.',
      };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(150, io.timeoutMs - (now - started))),
    );
  }
}
