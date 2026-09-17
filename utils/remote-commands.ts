// Method surface offered to the agent over the zylos-remote transport, and the
// only place remote `req` frames are turned into executor calls.
//
// The relay forwards `{method, params, requestId}` verbatim and knows nothing
// about this table; anything not listed here is refused with UNKNOWN_METHOD.
import { actionParams, commandSchema, type Command } from './commands';
import { isBlockedUrl } from './guard';
import {
  createTask,
  currentControl,
  currentGrant,
  execute,
  type NavigationWatch,
} from './automation/executor';
import { REMOTE_VERSION } from './remote';
import { usePageContext, clearPageContexts } from './page-context';
import {
  navigationActions,
  stepReceipt,
  type ActionStep,
  type StepObserver,
  type StepResult,
} from './action-step';
import {
  remoteParams as paramSchemas,
  REMOTE_METHODS,
  describeTools,
  type RemoteMethod,
} from './tool-catalog';
export { REMOTE_METHODS, type RemoteMethod } from './tool-catalog';

// Retried mutating calls replay their recorded answer instead of clicking twice.
const IDEMPOTENT_METHODS = new Set<RemoteMethod>([
  'step',
  'start',
  'use-current-tab',
  'open',
  'new-tab',
  'switch-tab',
  'click',
  'hover',
  'double-click',
  'right-click',
  'drag',
  'select',
  'check',
  'back',
  'forward',
  'reload',
  'fill',
  'type',
  'scroll',
  'keypress',
  'finalize',
]);
// Refused outright while the task tab sits on a blocklisted page. Leaving the
// page (open / new-tab / switch-tab) and ending (pause / finish / stop /
// finalize) stay available so the agent can get itself out.
const GUARDED_METHODS = new Set<RemoteMethod>([
  'snapshot',
  'observe',
  'screenshot',
  'find',
  'inspect',
  'frames',
  'wait',
  'click',
  'hover',
  'double-click',
  'right-click',
  'drag',
  'select',
  'check',
  'back',
  'forward',
  'reload',
  'fill',
  'type',
  'scroll',
  'keypress',
]);
const URL_METHODS = new Set<RemoteMethod>(['start', 'open', 'new-tab']);

export const REMOTE_CAPABILITIES = [
  ...REMOTE_METHODS,
  'idempotency-v1',
  'url-guard-v1',
  'task-tab-v1',
  'browser-actions-v2',
  'frames-v1',
  'popup-v1',
  'dialog-v1',
  'wait-v1',
  'chat-ack-v1',
  'tool-catalog-v1',
  'current-page-v1',
  'action-step-v1',
  'agent-loop-v1',
];

export class RemoteError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message = code, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
function fail(code: string, message = code, details?: unknown): never {
  throw new RemoteError(code, message, details);
}

export class IdempotencyCache {
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private pending = new Map<string, { signature: string; promise: Promise<unknown> }>();
  private signatures = new Map<string, string>();
  cancel() {
    this.epoch++;
  }
  run(req: Dispatch, work: (assertActive: () => void) => Promise<unknown>): Promise<unknown> {
    const urgent = ['stop', 'pause', 'finish', 'finalize'].includes(req.method);
    const independent =
      req.method === 'info' || req.method === 'describe' || req.method === 'dialog';
    if (urgent) this.cancel();
    const epoch = this.epoch;
    const id = req.requestId;
    const signature = JSON.stringify([req.method, req.params]);
    if (id) {
      const previous = this.pending.get(id);
      const saved = this.signatures.get(id);
      if ((previous && previous.signature !== signature) || (saved && saved !== signature))
        return Promise.reject(
          new RemoteError('REQUEST_ID_CONFLICT', 'requestId belongs to another command'),
        );
      if (previous)
        return previous.promise.then(
          (value) => ({ ...(value as object), replayed: true }),
          (error) => {
            if (error instanceof RemoteError && error.code === 'STEP_INCOMPLETE')
              throw new RemoteError(error.code, error.message, {
                ...(error.details as object),
                replayed: true,
              });
            throw error;
          },
        );
    }
    const assertActive = () => {
      if (!urgent && epoch !== this.epoch)
        fail('STOPPED', 'Command was queued before control was stopped');
    };
    const execute = async () => {
      assertActive();
      try {
        return await work(assertActive);
      } finally {
        if (id && this.map.has(id)) this.signatures.set(id, signature);
      }
    };
    const promise = urgent || independent ? execute() : this.queue.catch(() => {}).then(execute);
    if (!urgent && !independent) this.queue = promise.catch(() => {});
    if (id) {
      this.pending.set(id, { signature, promise });
      void promise.finally(() => this.pending.delete(id)).catch(() => {});
    }
    return promise;
  }

  private map = new Map<string, unknown>();
  constructor(private cap = 200) {}
  get(id: string) {
    if (!this.map.has(id)) return undefined;
    const v = this.map.get(id);
    this.map.delete(id);
    this.map.set(id, v);
    return v;
  }
  set(id: string, value: unknown) {
    this.map.set(id, value);
    while (this.map.size > this.cap) {
      const id = this.map.keys().next().value!;
      this.map.delete(id);
      this.signatures.delete(id);
    }
  }
  get size() {
    return this.map.size;
  }
}

/** Where a brand-new task tab goes: beside the active tab of the last focused normal window. */
async function sourceTab(): Promise<{ tabId: number; windowId: number }> {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (!win || win.id === undefined || win.incognito)
    return fail('NO_WINDOW', '没有可用的普通浏览器窗口');
  const windowId = win.id;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab || tab.id === undefined) return fail('NO_WINDOW', '没有可用的普通浏览器窗口');
  return { tabId: tab.id, windowId };
}

async function startTask(target: string, assertActive: () => void) {
  const source = await sourceTab();
  assertActive();
  const grant = await createTask({
    sourceTabId: source.tabId,
    url: target,
    taskId: crypto.randomUUID(),
    windowId: source.windowId,
  });
  const control = currentControl();
  return {
    started: true,
    tabId: grant?.id ?? control?.tabId ?? null,
    url: target,
    sessionId: control?.sessionId ?? null,
  };
}

export type Dispatch = {
  method: string;
  params: Record<string, unknown>;
  requestId?: string;
  deadline?: number;
  keyId: string;
};

export function dispatch(
  req: Dispatch,
  idem: IdempotencyCache,
  onStart?: () => void,
  onExecute?: () => void,
  onPart?: StepObserver,
): Promise<unknown> {
  return idem.run(req, (assertActive) => {
    onStart?.();
    return dispatchNow(req, idem, assertActive, onExecute, onPart);
  });
}
async function dispatchNow(
  req: Dispatch,
  idem: IdempotencyCache,
  assertActive: () => void,
  onExecute?: () => void,
  onPart?: StepObserver,
  navigation?: NavigationWatch,
): Promise<unknown> {
  const method = req.method as RemoteMethod;
  const schema = Object.hasOwn(paramSchemas, method) ? paramSchemas[method] : undefined;
  if (!schema) fail('UNKNOWN_METHOD', `unknown method ${req.method}; see info.capabilities`);

  const parsed = schema.safeParse(req.params ?? {});
  if (!parsed.success)
    fail(
      'BAD_PARAMS',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
    );
  const params = parsed.data as Record<string, unknown>;
  if (Object.hasOwn(actionParams, req.method)) {
    const command = commandSchema.safeParse({ op: req.method, ...params });
    if (!command.success) fail('BAD_PARAMS', command.error.issues.map((i) => i.message).join('; '));
  }

  const deadline = typeof req.deadline === 'number' ? req.deadline : Date.now() + 30_000;
  if (Date.now() > deadline) fail('COMMAND_EXPIRED');

  if (req.requestId && IDEMPOTENT_METHODS.has(method)) {
    const prior = idem.get(req.requestId);
    if (prior instanceof RemoteError)
      throw new RemoteError(prior.code, prior.message, {
        ...(prior.details as object),
        replayed: true,
      });
    if (prior !== undefined) return { ...(prior as object), replayed: true };
  }

  if (URL_METHODS.has(method) && isBlockedUrl(params.url)) {
    fail(
      'BLOCKED_URL',
      'refused: target URL is on the blocklist (payment / banking / account-security)',
      { url: params.url },
    );
  }
  if (GUARDED_METHODS.has(method)) {
    const here = currentGrant()?.url;
    if (isBlockedUrl(here)) {
      fail(
        'BLOCKED_URL',
        'refused: task tab is on a blocklisted page; ask the owner to handle it, or open another URL',
        { url: here },
      );
    }
  }

  // Only actual execution may resume a completed preview. Cache replays and
  // rejected requests must not restart its stream or change its terminal state.
  onExecute?.();
  let result: unknown;
  switch (method) {
    case 'step':
      result = await runStep(req, params as ActionStep, idem, assertActive, onPart);
      break;
    case 'use-current-tab':
      result = await usePageContext(params.contextId as string, assertActive);
      break;
    case 'describe': {
      if (params.method && params.methods) fail('BAD_PARAMS', 'Use method OR methods');
      const names = params.method
        ? [params.method as string]
        : (params.methods as string[] | undefined);
      if (names?.some((name) => !Object.hasOwn(paramSchemas, name)))
        fail(
          'UNKNOWN_METHOD',
          'Requested tool is not in this extension; call describe for its index',
        );
      result = describeTools(names as RemoteMethod[] | undefined);
      break;
    }
    case 'info':
      result = {
        name: 'zylos-browser-extension',
        version: REMOTE_VERSION,
        keyId: req.keyId,
        capabilities: REMOTE_CAPABILITIES,
        toolCatalog: { method: 'describe', schemaVersion: 1 },
        control: currentControl(),
        tab: currentGrant(),
      };
      break;
    case 'start':
      if (currentControl()) fail('TASK_ALREADY_STARTED', '已有工作标签；用 open 导航，或先 stop');
      result = await startTask(params.url as string, assertActive);
      break;
    case 'open':
      result = currentControl()
        ? await execute(commandSchema.parse({ op: 'open', url: params.url }), deadline)
        : await startTask(params.url as string, assertActive);
      break;
    case 'finalize': {
      const control = currentControl();
      if (!control) return fail('CONTROL_NOT_GRANTED', '没有进行中的任务');
      result = await execute(
        commandSchema.parse({ op: 'finalize', taskId: control.sessionId, keep: params.keep }),
        deadline,
      );
      break;
    }
    default:
      if (method === 'stop') clearPageContexts();
      result = await execute(
        commandSchema.parse({ op: method, ...params }) as Command,
        deadline,
        navigation,
      );
  }

  if (req.requestId && IDEMPOTENT_METHODS.has(method))
    idem.set(req.requestId, method === 'step' ? stepReceipt(result as StepResult) : result);
  return result ?? null;
}

async function runStep(
  req: Dispatch,
  params: ActionStep,
  idem: IdempotencyCache,
  assertActive: () => void,
  onPart?: StepObserver,
): Promise<StepResult> {
  const wait =
    params.wait ??
    (navigationActions.has(params.action.op)
      ? { condition: 'loaded' as const, timeoutMs: 10000 }
      : undefined);
  const commands = [params.action, ...(wait ? [{ op: 'wait', ...wait }] : []), params.read];
  // Created inside the queue, captured by the executor immediately before input.
  // The Agent never supplies a baseline or predicts the destination URL.
  const navigation: NavigationWatch | undefined = wait?.condition === 'navigation' ? {} : undefined;
  const result: StepResult = {
    completed: false,
    steps: commands.map((command, i) => ({
      stage: i === 0 ? 'action' : i === commands.length - 1 ? 'read' : 'wait',
      method: command.op,
      status: 'skipped',
    })),
  };
  // One queue slot for the entire sequence. Child dispatches must NOT re-enter
  // IdempotencyCache.run (which would deadlock behind their own parent).
  const deadline = req.deadline ?? Date.now() + 30000;
  let target: ReturnType<typeof currentControl> = null;
  for (const [index, command] of commands.entries()) {
    const part = result.steps[index]!;
    const { op, ...childParams } = command;
    let ticket: ReturnType<StepObserver>;
    const started = Date.now();
    try {
      assertActive();
      ticket = onPart?.(op, childParams);
      if (index > 0) {
        const now = currentControl();
        if (!target || !now || target.sessionId !== now.sessionId || target.tabId !== now.tabId)
          fail(
            'STOPPED',
            'The action target is no longer controlled; remaining stages were skipped',
          );
      }
      part.result = await dispatchNow(
        {
          ...req,
          method: op,
          params: index === 1 && navigation ? { ...childParams, condition: 'loaded' } : childParams,
          requestId: undefined,
          deadline,
        },
        idem,
        assertActive,
        undefined,
        undefined,
        index < 2 ? navigation : undefined,
      );
      part.status = 'success';
      ticket?.finish();
      if (index === 0) target = currentControl();
      // A click already acknowledged by Chrome can navigate before returning.
      // Finish that observed navigation without requiring a predicted URL.
      if (index === 0 && !wait && (part.result as { navigating?: boolean } | null)?.navigating) {
        commands.splice(1, 0, { op: 'wait', condition: 'loaded', timeoutMs: 10000 });
        result.steps.splice(1, 0, { stage: 'wait', method: 'wait', status: 'skipped' });
      }
    } catch (error) {
      const e = error as { code?: string; message?: string };
      const code = typeof e?.code === 'string' ? e.code : 'EXT_ERROR';
      part.status = 'error';
      part.error = { code, message: e?.message || code };
      ticket?.finish(code);
      part.durationMs = Date.now() - started;
      const failure = new RemoteError(
        'STEP_INCOMPLETE',
        `${part.stage} (${op}) failed: ${code}. Check details.steps; do not repeat completed actions.`,
        result,
      );
      // Cache failures too: the mutation may have succeeded before a failed
      // observation, or a mutation error may have an uncertain outcome.
      if (req.requestId)
        idem.set(
          req.requestId,
          new RemoteError(failure.code, failure.message, stepReceipt(result)),
        );
      throw failure;
    }
    part.durationMs = Date.now() - started;
  }
  result.completed = true;
  return result;
}
