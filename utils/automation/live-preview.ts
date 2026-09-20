import { isPanelSender } from '../messages';
import { PREVIEW_PORT, type PreviewFrame, type PreviewState } from '../live-preview';
import type { GrantedTab, Scope } from './types';

type Client = { port: chrome.runtime.Port; visible: boolean; pending: number | null; sent: number };
type Capture = { key: string; tabId: number };
const MIN_FRAME_MS = 100; // At most 10 thumbnail updates/sec; Chrome still pushes the frames.
const PASSIVE = new Set([
  'read-page',
  'info',
  'describe',
  'tabs',
  'finish',
  'pause',
  'stop',
  'finalize',
]);

/** Shares the executor's existing debugger attachment; never attaches or selects a tab. */
export class LivePreview {
  private state: PreviewState | null = null;
  private frame: PreviewFrame | null = null;
  private clients = new Set<Client>();
  private target: Capture | null = null;
  private stream: Capture | null = null;
  private attempted: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private sequence = 0;
  private lastSent = 0;
  private lastFailed = false;
  private terminal = false;
  private controlled = false;
  private firstFrameTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    chrome.runtime.onConnect.addListener((port) => this.connect(port));
    chrome.debugger.onEvent.addListener((source, method, params) =>
      this.event(source, method, params),
    );
    chrome.tabs.onRemoved.addListener((id) => {
      if (this.state?.tabId !== id) return;
      this.state.canReveal = false;
      if (this.state.canStop) this.finish('interrupted');
      this.publish();
    });
  }

  sync(control: Scope | null, grant: GrantedTab | null, connected: boolean) {
    const before = JSON.stringify(this.state);
    this.controlled = !!control;
    if (control) {
      const changed =
        this.state?.sessionId !== control.sessionId || this.state.tabId !== control.tabId;
      const usable = grant?.id === control.tabId ? grant : null;
      const navigated = !!usable && !!this.state && this.state.url !== usable.url;
      if (changed || navigated) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        this.frame = null;
        this.lastSent = 0;
        if (changed) {
          this.lastFailed = false;
          this.terminal = false;
        }
        this.state = {
          targetKey: `${control.sessionId}:${control.tabId}:${++this.revision}`,
          sessionId: control.sessionId,
          tabId: control.tabId,
          windowId: control.windowId,
          title: usable?.title ?? '',
          url: usable?.url ?? '',
          status:
            !changed && this.terminal
              ? this.state!.status
              : control.phase === 'ready'
                ? 'running'
                : 'paused',
          availability: this.terminal ? 'paused' : 'connecting',
          canReveal: true,
          canStop: !this.terminal,
        };
        for (const client of this.clients) client.pending = null;
      }
      if (this.state && !this.terminal) {
        this.state.status = control.phase === 'ready' ? 'running' : 'paused';
        this.state.canStop = true;
        if (usable) {
          this.state.title = usable.title;
          this.state.url = usable.url;
        }
      }
      this.target =
        usable && connected && !this.terminal && control.phase === 'ready' && this.state
          ? { key: this.state.targetKey, tabId: usable.id }
          : null;
    } else {
      this.target = null;
      if (this.state && !this.terminal) {
        // Losing control alone is not evidence of success. Wait for finish/final reply.
        this.state.status = 'paused';
        this.state.canStop = false;
      }
    }
    if (this.state && this.terminal)
      this.state.canStop = this.controlled && ['interrupted', 'error'].includes(this.state.status);
    if (!this.target && this.state) this.state.availability = 'paused';
    if (JSON.stringify(this.state) !== before) this.publish();
    this.reconcile();
  }

  resume(method: string) {
    if (PASSIVE.has(method)) return;
    this.terminal = false;
    // Retry a previously unavailable stream only on a new operation/visibility change.
    if (!this.stream) this.attempted = null;
  }

  result(method: string, failed: boolean, unresolvedErrors = false) {
    if (!PASSIVE.has(method)) this.lastFailed = failed;
    if (!failed && ['finish', 'finalize'].includes(method))
      this.finish(unresolvedErrors ? 'error' : 'completed');
    if (!failed && method === 'stop') this.finish('stopped');
  }

  finish(status: 'completed' | 'stopped' | 'interrupted' | 'error') {
    if (!this.state) return;
    // A late final reply must not turn a cancelled/disconnected task green.
    if (this.terminal && status !== 'error' && !(status === 'stopped' && this.state.canStop))
      return;
    this.state.status = status === 'completed' && this.lastFailed ? 'error' : status;
    this.state.availability = 'paused';
    // Offline/error outcomes may still leave browser control attached. Let the
    // owner release it locally even when the Agent connection is unavailable.
    this.state.canStop = this.controlled && ['interrupted', 'error'].includes(this.state.status);
    this.terminal = true;
    this.target = null;
    this.publish();
    this.flushFrames();
    this.reconcile();
  }

  clear() {
    if (this.state?.canStop) return;
    this.state = null;
    this.frame = null;
    this.target = null;
    this.publish();
    this.reconcile();
  }

  async reveal() {
    const state = this.state;
    if (!state?.canReveal) throw new Error('ui.error.previewTabClosed');
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!tab || tab.windowId !== state.windowId || tab.incognito) {
      if (this.state === state) {
        state.canReveal = false;
        this.publish();
      }
      throw new Error('ui.error.previewTabClosed');
    }
    if (this.state !== state) return;
    if (typeof tab.groupId === 'number' && tab.groupId >= 0)
      await chrome.tabGroups.update(tab.groupId, { collapsed: false });
    if (this.state !== state) return;
    await chrome.tabs.update(tab.id!, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  private connect(port: chrome.runtime.Port) {
    if (port.name !== PREVIEW_PORT) return;
    if (!port.sender || !isPanelSender(port.sender)) {
      port.disconnect();
      return;
    }
    const client: Client = { port, visible: false, pending: null, sent: 0 };
    this.clients.add(client);
    port.onMessage.addListener((m: unknown) => {
      if (!m || typeof m !== 'object') return;
      if (
        'type' in m &&
        m.type === 'visibility' &&
        'visible' in m &&
        typeof m.visible === 'boolean'
      ) {
        client.visible = m.visible;
        client.pending = null;
        if (m.visible) {
          this.attempted = null;
          this.post(client, { type: 'preview-state', preview: this.state });
          this.postFrame(client);
        }
        this.reconcile();
      } else if (
        'type' in m &&
        m.type === 'ack' &&
        'sequence' in m &&
        m.sequence === client.pending
      ) {
        client.pending = null;
        if (this.frame && this.frame.sequence !== m.sequence) this.flushFrames();
      }
    });
    port.onDisconnect.addListener(() => {
      this.clients.delete(client);
      this.reconcile();
    });
  }

  private post(client: Client, message: unknown) {
    try {
      client.port.postMessage(message);
    } catch {
      this.clients.delete(client);
      this.reconcile();
    }
  }
  private postFrame(client: Client) {
    if (
      !client.visible ||
      client.pending !== null ||
      !this.frame ||
      client.sent === this.frame.sequence
    )
      return;
    client.pending = this.frame.sequence;
    client.sent = this.frame.sequence;
    this.post(client, { type: 'preview-frame', frame: this.frame });
  }
  private publish() {
    // A dismissed preview still needs task/completion metadata so its Stop
    // control stays accurate and a new task can show the preview again.
    for (const client of this.clients)
      this.post(client, { type: 'preview-state', preview: this.state });
  }
  private flushFrames() {
    const delay = MIN_FRAME_MS - (Date.now() - this.lastSent);
    if (delay > 0) {
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = undefined;
        this.flushFrames();
      }, delay);
      return;
    }
    this.lastSent = Date.now();
    for (const client of this.clients) this.postFrame(client);
  }
  private desired() {
    return [...this.clients].some((c) => c.visible) ? this.target : null;
  }
  private command(tabId: number, method: string, params?: Record<string, unknown>) {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
  private reconcile() {
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        let wanted = this.desired();
        if (this.stream && this.stream.key !== wanted?.key) {
          const old = this.stream;
          this.stream = null;
          clearTimeout(this.firstFrameTimer);
          await this.command(old.tabId, 'Page.stopScreencast').catch(() => {});
          this.attempted = null;
        }
        wanted = this.desired();
        if (!wanted || this.stream || this.attempted === wanted.key) return;
        const capture = { ...wanted };
        this.attempted = capture.key;
        this.stream = capture;
        this.setAvailability('connecting');
        try {
          await this.command(capture.tabId, 'Page.startScreencast', {
            format: 'jpeg',
            quality: 55,
            maxWidth: 640,
            maxHeight: 360,
            everyNthFrame: 1,
          });
          if (this.desired()?.key !== capture.key) {
            this.reconcile();
            return;
          }
          if (this.state?.availability !== 'live') {
            this.firstFrameTimer = setTimeout(() => {
              if (this.stream === capture && this.desired()?.key === capture.key)
                this.setAvailability('unavailable');
            }, 5000);
          }
        } catch {
          if (this.stream === capture) this.stream = null;
          if (this.target?.key === capture.key) this.setAvailability('unavailable');
        }
      });
  }
  private setAvailability(value: PreviewState['availability']) {
    if (!this.state || this.state.availability === value) return;
    this.state.availability = value;
    this.publish();
  }
  private event(source: chrome.debugger.DebuggerSession, method: string, params?: object) {
    const stream = this.stream;
    if (!stream || source.tabId !== stream.tabId || source.sessionId) return;
    if (method === 'Page.screencastFrame') {
      const p = params as { sessionId?: number; data?: string } | undefined;
      if (typeof p?.sessionId === 'number')
        void this.command(stream.tabId, 'Page.screencastFrameAck', {
          sessionId: p.sessionId,
        }).catch(() => {});
      if (this.desired()?.key !== stream.key || this.state?.targetKey !== stream.key) return;
      if (!p?.data || p.data.length > 490_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data)) return;
      clearTimeout(this.firstFrameTimer);
      this.setAvailability('live');
      const now = Date.now();
      this.frame = {
        targetKey: stream.key,
        sequence: ++this.sequence,
        capturedAt: now,
        dataUrl: `data:image/jpeg;base64,${p.data}`,
      };
      this.flushFrames();
    } else if (
      method === 'Page.screencastVisibilityChanged' &&
      this.desired()?.key === stream.key
    ) {
      if (!(params as { visible?: boolean })?.visible) this.setAvailability('paused');
    }
  }
}
