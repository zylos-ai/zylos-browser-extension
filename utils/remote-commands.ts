// Method surface offered to the agent over the zylos-remote transport, and the
// only place remote `req` frames are turned into executor calls.
//
// The relay forwards `{method, params, requestId}` verbatim and knows nothing
// about this table; anything not listed here is refused with UNKNOWN_METHOD.
import { z } from 'zod';
import { actionParams, commandSchema, type Command } from './commands';
import { isBlockedUrl } from './guard';
import { createTask, currentControl, currentGrant, execute } from './automation/executor';
import { REMOTE_VERSION } from './remote';

const url = z.string().url().max(4000);
// Agent-visible actions use exactly the same schemas as the executor.
const paramSchemas = {
  ...actionParams,
  info: z.object({}).strict(),
  start: z.object({ url }).strict(),
  finalize: z.object({ keep: z.array(z.number().int().nonnegative()).max(8).default([]) }).strict(),
} as const;

export type RemoteMethod = keyof typeof paramSchemas;
export const REMOTE_METHODS = Object.keys(paramSchemas) as RemoteMethod[];

// Retried mutating calls replay their recorded answer instead of clicking twice.
const IDEMPOTENT_METHODS = new Set<RemoteMethod>([
  'start',
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
  run(req: Dispatch, work: () => Promise<unknown>): Promise<unknown> {
    const urgent = ['stop', 'pause', 'finish', 'finalize'].includes(req.method);
    const independent = req.method === 'info' || req.method === 'dialog';
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
        return previous.promise.then((value) => ({ ...(value as object), replayed: true }));
    }
    const execute = async () => {
      if (!urgent && epoch !== this.epoch)
        fail('STOPPED', 'Command was queued before control was stopped');
      const result = await work();
      if (id && this.map.has(id)) this.signatures.set(id, signature);
      return result;
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

async function startTask(target: string) {
  const source = await sourceTab();
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

export function dispatch(req: Dispatch, idem: IdempotencyCache): Promise<unknown> {
  return idem.run(req, () => dispatchNow(req, idem));
}
async function dispatchNow(req: Dispatch, idem: IdempotencyCache): Promise<unknown> {
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

  let result: unknown;
  switch (method) {
    case 'info':
      result = {
        name: 'zylos-browser-extension',
        version: REMOTE_VERSION,
        keyId: req.keyId,
        capabilities: REMOTE_CAPABILITIES,
        control: currentControl(),
        tab: currentGrant(),
      };
      break;
    case 'start':
      if (currentControl()) fail('TASK_ALREADY_STARTED', '已有工作标签；用 open 导航，或先 stop');
      result = await startTask(params.url as string);
      break;
    case 'open':
      result = currentControl()
        ? await execute(commandSchema.parse({ op: 'open', url: params.url }), deadline)
        : await startTask(params.url as string);
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
      result = await execute(commandSchema.parse({ op: method, ...params }) as Command, deadline);
  }

  if (req.requestId && IDEMPOTENT_METHODS.has(method)) idem.set(req.requestId, result);
  return result ?? null;
}
