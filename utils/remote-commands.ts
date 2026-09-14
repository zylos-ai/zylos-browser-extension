// Method surface offered to the agent over the zylos-remote transport, and the
// only place remote `req` frames are turned into executor calls.
//
// The relay forwards `{method, params, requestId}` verbatim and knows nothing
// about this table; anything not listed here is refused with UNKNOWN_METHOD.
import { z } from 'zod';
import { commandSchema, type Command } from './commands';
import { isBlockedUrl } from './guard';
import { attach, currentControl, currentGrant, execute } from './automation/executor';
import { REMOTE_VERSION } from './remote';

const url = z.string().url().max(4000);
const ref = z.string().max(100);
const text = z.string().max(20000);

// Params schemas; each maps 1:1 onto an executor command or a local action.
const paramSchemas = {
  info: z.object({}).strict(),
  start: z.object({ url }).strict(),
  open: z.object({ url }).strict(),
  'new-tab': z.object({ url }).strict(),
  'switch-tab': z.object({ tabId: z.number().int().nonnegative() }).strict(),
  tabs: z.object({}).strict(),
  snapshot: z.object({ interactive: z.boolean().default(false) }).strict(),
  observe: z.object({ interactive: z.boolean().default(false) }).strict(),
  screenshot: z.object({}).strict(),
  click: z.object({ ref }).strict(),
  fill: z.object({ ref, text }).strict(),
  type: z.object({ ref, text }).strict(),
  scroll: z
    .object({
      direction: z.enum(['up', 'down', 'left', 'right']),
      pixels: z.number().int().min(1).max(2000).default(500),
    })
    .strict(),
  keypress: z
    .object({
      key: z.enum([
        'Enter',
        'Tab',
        'Escape',
        'Backspace',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
      ]),
    })
    .strict(),
  pause: z.object({}).strict(),
  finish: z.object({}).strict(),
  stop: z.object({}).strict(),
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
  'click',
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
const fail = (code: string, message = code, details?: unknown): never => {
  throw new RemoteError(code, message, details);
};

export class IdempotencyCache {
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
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value!);
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
  const grant = await attach(source.tabId, 'new', {
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

export async function dispatch(req: Dispatch, idem: IdempotencyCache): Promise<unknown> {
  const method = req.method as RemoteMethod;
  const schema = paramSchemas[method];
  if (!schema) fail('UNKNOWN_METHOD', `unknown method ${req.method}; see info.capabilities`);

  const parsed = schema.safeParse(req.params ?? {});
  if (!parsed.success)
    fail(
      'BAD_PARAMS',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
    );
  const params = parsed.data as Record<string, unknown>;

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
