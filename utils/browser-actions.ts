// Guarded local browser actions used only by the extension-owned loop.
import { actionParams, commandSchema, type Command } from './commands';
import { isBlockedUrl } from './guard';
import { createTask, currentControl, currentGrant, execute } from './automation/executor';
import { usePageContext, readPageContext } from './page-context';
import { browserParams as paramSchemas, BROWSER_METHODS, type BrowserMethod } from './tool-catalog';
export { BROWSER_METHODS, type BrowserMethod } from './tool-catalog';

// Retried mutating calls replay their recorded answer instead of clicking twice.
const IDEMPOTENT_METHODS = new Set<BrowserMethod>([
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
]);
// Refused outright while the task tab sits on a blocklisted page. Leaving the
// page (open / new-tab / switch-tab) stays available. The owner can always stop.
const GUARDED_METHODS = new Set<BrowserMethod>([
  'snapshot',
  'observe',
  'find',
  'inspect',
  'frames',
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
const URL_METHODS = new Set<BrowserMethod>(['open', 'new-tab']);

export const REMOTE_CAPABILITIES = ['agent-loop-v1'];

export class BrowserActionError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message = code, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
function fail(code: string, message = code, details?: unknown): never {
  throw new BrowserActionError(code, message, details);
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
    const independent = req.method === 'dialog';
    const epoch = this.epoch;
    const id = req.requestId;
    const signature = JSON.stringify([req.method, req.params]);
    if (id) {
      const previous = this.pending.get(id);
      const saved = this.signatures.get(id);
      if ((previous && previous.signature !== signature) || (saved && saved !== signature))
        return Promise.reject(
          new BrowserActionError('REQUEST_ID_CONFLICT', 'requestId belongs to another command'),
        );
      if (previous)
        return previous.promise.then((value) => ({ ...(value as object), replayed: true }));
    }
    const assertActive = () => {
      if (epoch !== this.epoch) fail('STOPPED', 'Command was queued before control was stopped');
    };
    const execute = async () => {
      assertActive();
      try {
        return await work(assertActive);
      } finally {
        if (id && this.map.has(id)) this.signatures.set(id, signature);
      }
    };
    const promise = independent ? execute() : this.queue.catch(() => {}).then(execute);
    if (!independent) this.queue = promise.catch(() => {});
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
): Promise<unknown> {
  return idem.run(req, (assertActive) => {
    onStart?.();
    return dispatchNow(req, idem, assertActive, onExecute);
  });
}
async function dispatchNow(
  req: Dispatch,
  idem: IdempotencyCache,
  assertActive: () => void,
  onExecute?: () => void,
): Promise<unknown> {
  const method = req.method as BrowserMethod;
  const schema = Object.hasOwn(paramSchemas, method) ? paramSchemas[method] : undefined;
  if (!schema) fail('UNKNOWN_METHOD', `unknown browser action ${req.method}`);

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

  // A DOM read does not acquire control or resume a CDP preview.
  if (method === 'read-page')
    return readPageContext(params.contextId as string, params, assertActive);

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

  // Only actual execution may resume a completed preview. Cache replays and
  // rejected requests must not restart its stream or change its terminal state.
  onExecute?.();
  let result: unknown;
  switch (method) {
    case 'use-current-tab':
      result = await usePageContext(params.contextId as string, assertActive);
      break;
    case 'open':
      result = currentControl()
        ? await execute(commandSchema.parse({ op: 'open', url: params.url }), deadline)
        : await startTask(params.url as string, assertActive);
      break;
    default:
      result = await execute(commandSchema.parse({ op: method, ...params }) as Command, deadline);
  }

  if (req.requestId && IDEMPOTENT_METHODS.has(method)) idem.set(req.requestId, result);
  return result ?? null;
}
