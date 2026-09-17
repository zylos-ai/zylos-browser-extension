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
  // Retry evidence lives only in memory; raw arguments must never enter chat storage.
  private failures = new Map<string, { step: ToolStep; signature: string; context: string }>();
  constructor(
    private chat: () => ChatEntry[],
    private changed: () => void,
    private context: () => string | undefined = () => undefined,
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
      this.failures.clear();
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
    for (const [id, entry] of this.failures)
      if (!run.steps.includes(entry.step)) this.failures.delete(id);
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
    let evidence: { signature: string; context: string } | undefined;
    return {
      start: () => {
        if (!pending()) return;
        if (
          [
            'start',
            'open',
            'new-tab',
            'switch-tab',
            'use-current-tab',
            'back',
            'forward',
            'reload',
          ].includes(method)
        )
          this.failures.clear();
        const context = this.context();
        if (context !== undefined) {
          const signature = JSON.stringify([method, params], (_key, value) =>
            value && typeof value === 'object' && !Array.isArray(value)
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [key, value[key]]),
                )
              : value,
          );
          evidence = { context, signature };
        }
        step.status = 'running';
        step.startedAt = Date.now();
        this.changed();
      },
      finish: (errorCode?: string, replayed?: boolean) => {
        if (!pending()) return;
        step.status = errorCode === 'STOPPED' ? 'cancelled' : errorCode ? 'error' : 'success';
        if (step.status === 'error' && !replayed) run.failed++;
        step.errorCode = errorCode?.replace(/[^\w-]/g, '').slice(0, 64);
        step.replayed = replayed || undefined;
        if (evidence && step.status === 'error' && !replayed)
          this.failures.set(step.id, { step, ...evidence });
        if (
          evidence &&
          step.status === 'success' &&
          !replayed &&
          this.context() === evidence.context
        ) {
          for (const [id, failed] of this.failures) {
            if (failed.context !== evidence.context || failed.signature !== evidence.signature)
              continue;
            failed.step.recovered = true;
            run.recovered = (run.recovered ?? 0) + 1;
            this.failures.delete(id);
          }
        }
        step.endedAt = Date.now();
        this.changed();
      },
      stop: () => {
        if (this.active === entry) this.end('stopped');
      },
    };
  }

  hasUnresolvedErrors() {
    const run = this.active?.toolRun;
    return !!run && run.failed > (run.recovered ?? 0);
  }

  end(status: Exclude<ToolRun['status'], 'running'>) {
    const entry = this.active;
    this.active = undefined;
    this.failures.clear();
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
