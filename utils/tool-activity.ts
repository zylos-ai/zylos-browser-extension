import {
  CHAT_LOG_CAP,
  TOOL_STEPS_CAP,
  type ChatEntry,
  type ToolRun,
  type ToolStep,
} from './remote';

// A short target hint, not an argument dump. Inputs, query strings, page contents,
// screenshot data and arbitrary error messages must not be copied into history.
function targetHint(params: Record<string, unknown>): string | undefined {
  if (typeof params.url === 'string') {
    try {
      const url = new URL(params.url);
      if (['http:', 'https:'].includes(url.protocol))
        return `${url.origin}${url.pathname}`.slice(0, 240);
    } catch {
      /* invalid arguments are reported by the dispatcher */
    }
  }
  if (typeof params.ref === 'string') return params.ref.slice(0, 240);
  if (typeof params.tabId === 'number') return `Tab ${params.tabId}`;
  if (typeof params.x === 'number' && typeof params.y === 'number')
    return `(${params.x}, ${params.y})`;
  return undefined;
}

function endRun(run: ToolRun, status: Exclude<ToolRun['status'], 'running'>) {
  run.status = status;
  run.endedAt = Date.now();
  for (const step of run.steps) {
    if (step.status !== 'queued' && step.status !== 'running') continue;
    step.status = step.status === 'queued' ? 'cancelled' : 'interrupted';
    step.endedAt = run.endedAt;
  }
}

/** Extension-side observation only. Never sends extra requests to the Agent. */
export class ToolActivity {
  private active?: ChatEntry;
  private sequence = 0;
  constructor(
    private chat: () => ChatEntry[],
    private changed: () => void,
  ) {}

  begin(method: string, params: Record<string, unknown>) {
    const chat = this.chat();
    if (!this.active || !chat.includes(this.active)) {
      // Background capability/health probes outside a conversation are not a task.
      const turnIndex = chat.findLastIndex(
        (m) => m.role === 'user' || (m.role === 'assistant' && m.final !== false),
      );
      const waiting =
        chat[turnIndex]?.role === 'user' &&
        chat[turnIndex]?.delivery !== 'failed' &&
        !chat.slice(turnIndex + 1).some((m) => m.toolRun && m.toolRun.status !== 'running');
      if (['info', 'describe'].includes(method) && !waiting) return;
      const ts = Date.now();
      this.active = {
        id: `tools-${crypto.randomUUID()}-${++this.sequence}`,
        role: 'system',
        text: '',
        ts,
        toolRun: { status: 'running', startedAt: ts, total: 0, failed: 0, steps: [] },
      };
      chat.push(this.active);
      if (chat.length > CHAT_LOG_CAP) chat.splice(0, chat.length - CHAT_LOG_CAP);
    }
    const entry = this.active;
    const run = entry.toolRun!;
    const step: ToolStep = {
      id: `${entry.id}-${++run.total}`,
      number: run.total,
      method,
      target: targetHint(params),
      status: 'queued',
      queuedAt: Date.now(),
    };
    run.steps.push(step);
    if (run.steps.length > TOOL_STEPS_CAP) run.steps.splice(0, run.steps.length - TOOL_STEPS_CAP);
    // Bound aggregate history well below Chrome's storage quota too.
    let excess = chat.reduce((count, m) => count + (m.toolRun?.steps.length ?? 0), 0) - 2000;
    for (const message of chat) {
      if (excess <= 0) break;
      const old = message.toolRun;
      if (!old || old === run) continue;
      const remove = Math.min(excess, old.steps.length);
      old.steps.splice(0, remove);
      excess -= remove;
    }
    this.changed();
    const pending = () =>
      this.chat().includes(entry) &&
      run.status === 'running' &&
      (step.status === 'queued' || step.status === 'running');
    return {
      start: () => {
        if (!pending()) return;
        step.status = 'running';
        step.startedAt = Date.now();
        this.changed();
      },
      finish: (errorCode?: string, replayed?: boolean) => {
        if (!pending()) return;
        step.status = errorCode === 'STOPPED' ? 'cancelled' : errorCode ? 'error' : 'success';
        if (step.status === 'error') run.failed++;
        step.errorCode = errorCode?.replace(/[^\w-]/g, '').slice(0, 64);
        step.replayed = replayed || undefined;
        step.endedAt = Date.now();
        this.changed();
      },
      stop: () => {
        if (this.active === entry) this.end('stopped');
      },
    };
  }

  end(status: Exclude<ToolRun['status'], 'running'>) {
    const entry = this.active;
    this.active = undefined;
    if (!entry || !this.chat().includes(entry)) return;
    endRun(entry.toolRun!, status);
    this.changed();
  }

  recover() {
    let changed = false;
    for (const entry of this.chat()) {
      if (entry.toolRun?.status !== 'running') continue;
      endRun(entry.toolRun, 'interrupted');
      changed = true;
    }
    return changed;
  }
}
