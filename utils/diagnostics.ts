import { z } from 'zod';
import {
  diagnosticEventSchema,
  diagnosticMetadata,
  diagnosticMethod,
  diagnosticsQuery,
  panelDiagnosticSchema,
  safeError,
  type DiagnosticEvent,
  type DiagnosticMetadata,
  type DiagnosticReason,
} from './diagnostics-schema';
export { diagnosticsQuery } from './diagnostics-schema';
export type { DiagnosticEvent, DiagnosticReason } from './diagnostics-schema';

export const DIAGNOSTICS_CAPABILITY = 'diagnostics-v2';
const KEY = 'remote-diagnostics-session';
export const DIAGNOSTICS_ENABLED_KEY = 'remote-diagnostics-enabled';
export const CAP = 1000;
export const MAX_BYTES = 256 * 1024;
export const TTL = 30 * 60_000;
let enabled = false;
let consent = '';
let epoch = '';
let seq = 0;
let dropped = 0;
let restartCount = 0;
let storageHealthy = true;
let taskCounter = 0;
let opCounter = 0;
let currentTask: number | undefined;
let currentOp: number | undefined;
let events: DiagnosticEvent[] = [];
let queue: Promise<unknown> = Promise.resolve();
let consentWrites: Promise<unknown> = Promise.resolve();
let writing = false;
let dirty = false;
export const diagnosticsEnabled = () => enabled;
export const diagnosticsConsent = () => (enabled ? consent : '');
export const diagnosticsEpoch = () => epoch;
export function expireDiagnostics() {
  prune();
  persist();
}
function prune() {
  const kept = events.filter((e) => e.at > Date.now() - TTL).slice(-CAP);
  dropped += events.length - kept.length;
  events = kept;
  while (JSON.stringify(events).length > MAX_BYTES) {
    events.shift();
    dropped++;
  }
}
function snapshot() {
  return {
    schemaVersion: 2,
    epoch,
    consent,
    seq,
    dropped,
    restartCount,
    storageHealthy,
    taskCounter,
    opCounter,
    events,
  };
}
function persist() {
  dirty = true;
  if (writing) return;
  writing = true;
  queue = (async () => {
    try {
      while (dirty) {
        dirty = false;
        prune();
        await chrome.storage.session.set({ [KEY]: snapshot() });
      }
    } catch (error) {
      storageHealthy = false;
      // Do not recurse into storage when recording a storage failure.
      append('storage-error', {
        source: 'background',
        level: 'error',
        code: 'STORAGE_WRITE_FAILED',
      });
      throw error;
    } finally {
      writing = false;
    }
  })();
  void queue.catch(() => {});
}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const savedSchema = z.object({
  schemaVersion: z.literal(2),
  epoch: z.string().uuid(),
  consent: z.string(),
  seq: integer,
  dropped: integer,
  restartCount: integer,
  storageHealthy: z.boolean(),
  taskCounter: integer,
  opCounter: integer,
  events: z.array(diagnosticEventSchema).max(CAP),
});
export async function initializeDiagnostics() {
  enabled = false;
  events = [];
  seq = 0;
  dropped = 0;
  currentTask = undefined;
  currentOp = undefined;
  taskCounter = 0;
  opCounter = 0;
  restartCount = 0;
  storageHealthy = true;
  epoch = crypto.randomUUID();
  consent = '';
  const settings = await chrome.storage.local.get([DIAGNOSTICS_ENABLED_KEY]);
  enabled = settings[DIAGNOSTICS_ENABLED_KEY] === true;
  try {
    const saved = await chrome.storage.session.get(KEY);
    const parsed = savedSchema.safeParse(saved[KEY]);
    if (parsed.success) {
      const s = parsed.data;
      epoch = s.epoch;
      seq = s.seq;
      dropped = s.dropped;
      restartCount = s.restartCount + 1;
      taskCounter = s.taskCounter;
      opCounter = s.opCounter;
      storageHealthy = s.storageHealthy;
      consent = enabled ? s.consent : '';
      events = enabled ? s.events : [];
    } else if (enabled && saved[KEY] !== undefined) {
      storageHealthy = false;
      append('storage-error', { level: 'error', code: 'STORAGE_READ_FAILED' });
    }
  } catch {
    storageHealthy = false;
    append('storage-error', { level: 'error', code: 'STORAGE_READ_FAILED' });
  }
  if (enabled && !consent) consent = crypto.randomUUID();
  append('worker-start', { source: 'background' });
  persist();
  await queue;
}
export async function setDiagnosticsEnabled(value: boolean) {
  enabled = value;
  consent = value ? crypto.randomUUID() : '';
  // New consent gets a new epoch; no queued panel event can cross this boundary.
  epoch = crypto.randomUUID();
  const changeEpoch = epoch;
  events = [];
  seq = 0;
  dropped = 0;
  restartCount = 0;
  storageHealthy = true;
  currentTask = undefined;
  currentOp = undefined;
  taskCounter = 0;
  opCounter = 0;
  const saving = consentWrites
    .catch(() => {})
    .then(() => chrome.storage.local.set({ [DIAGNOSTICS_ENABLED_KEY]: value }));
  consentWrites = saving;
  try {
    await saving;
  } catch (error) {
    if (epoch === changeEpoch) {
      enabled = false;
      consent = '';
      events = [];
      persist();
    }
    throw error;
  }
  if (epoch !== changeEpoch) return;
  if (value) append('enabled', {});
  persist();
  await queue;
}
function append(event: DiagnosticEvent['event'], metadata: DiagnosticMetadata) {
  if (!enabled) return;
  const parsed = diagnosticEventSchema.safeParse({
    task: currentTask,
    op: currentOp,
    ...metadata,
    seq: seq + 1,
    at: Date.now(),
    event,
  });
  if (!parsed.success) return;
  seq++;
  events.push(parsed.data);
  prune();
}
export function recordDiagnostic(
  event: DiagnosticEvent['event'],
  reason?: DiagnosticReason,
  metadata: DiagnosticMetadata = {},
) {
  if (!enabled) return;
  append(event, { ...metadata, ...(reason ? { reason } : {}) });
  persist();
}
export function recordLifecycle(
  event: DiagnosticEvent['event'],
  metadata: DiagnosticMetadata = {},
) {
  if (!enabled) return;
  const parsed = diagnosticMetadata.safeParse(metadata);
  if (parsed.success) {
    append(event, parsed.data);
    persist();
  }
}
export function startDiagnosticTask() {
  currentTask = ++taskCounter;
  currentOp = undefined;
  recordLifecycle('task-start');
  return currentTask;
}
export function endDiagnosticTask(
  status: 'done' | 'blocked' | 'stopped' | 'interrupted',
  cancel = false,
) {
  recordLifecycle(cancel ? 'task-cancel' : 'task-end', { status });
  currentTask = undefined;
  currentOp = undefined;
}
export function startDiagnosticOperation(method: string) {
  const parsed = diagnosticMethod.safeParse(method);
  const context = {
    task: currentTask,
    op: ++opCounter,
    method: parsed.success ? parsed.data : ('other' as const),
  };
  currentOp = context.op;
  recordLifecycle('operation-start', context);
  return { ...context, captureEpoch: epoch };
}
export function endDiagnosticOperation(
  context: ReturnType<typeof startDiagnosticOperation>,
  error?: unknown,
  failed = error !== undefined,
) {
  if (context.captureEpoch !== epoch) return;
  const { captureEpoch: _, ...metadata } = context;
  recordLifecycle(failed ? 'operation-error' : 'operation-result', {
    ...metadata,
    status: failed ? 'error' : 'success',
    level: failed ? 'error' : 'info',
    ...(failed ? safeError(error) : {}),
  });
  if (currentOp === context.op) currentOp = undefined;
}
export function diagnosticRequest(method: string) {
  const parsed = diagnosticMethod.safeParse(method);
  const context = { op: ++opCounter, method: parsed.success ? parsed.data : ('other' as const) };
  recordLifecycle('request', context);
  return { ...context, captureEpoch: epoch };
}
export function acceptPanelDiagnostic(token: string, raw: unknown) {
  if (!enabled || !token || token !== consent) return false;
  const parsed = panelDiagnosticSchema.safeParse(raw);
  if (!parsed.success) return false;
  const { event, ...metadata } = parsed.data;
  if (event === 'capture-overflow') dropped += metadata.count ?? 1;
  recordLifecycle(event, { ...metadata, source: 'sidepanel', task: undefined, op: undefined });
  return true;
}
export async function diagnosticStorage<T>(kind: 'read' | 'write', work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    recordLifecycle('storage-error', {
      level: 'error',
      ...safeError(error),
      code: kind === 'read' ? 'STORAGE_READ_FAILED' : 'STORAGE_WRITE_FAILED',
    });
    throw error;
  }
}
export async function getDiagnostics(params: unknown) {
  const query = diagnosticsQuery.parse(params);
  await queue.catch(() => {});
  if (query.epoch && query.epoch !== epoch)
    throw Object.assign(new Error('Diagnostic capture reset'), { code: 'DIAGNOSTICS_RESET' });
  prune();
  persist();
  const highWater = query.through ?? seq;
  const after = query.after ?? 0;
  if (highWater > seq || after > highWater)
    throw new z.ZodError([
      { code: 'custom', path: ['after'], message: 'Cursor outside capture bounds' },
    ]);
  const available = enabled ? events.filter((e) => e.seq > after && e.seq <= highWater) : [];
  const result: DiagnosticEvent[] = [];
  let nextCursor = Math.max(after, highWater);
  let scanned = 0;
  for (const event of available) {
    scanned++;
    if (
      (!query.level || query.level === event.level) &&
      (!query.source || query.source === event.source) &&
      (query.task === undefined || query.task === event.task)
    )
      result.push({ ...event });
    if (result.length === query.limit) {
      nextCursor = event.seq;
      break;
    }
  }
  return {
    schemaVersion: 2,
    enabled,
    version: chrome.runtime.getManifest().version,
    epoch,
    events: result,
    nextCursor,
    highWater,
    dropped,
    hasMore: scanned < available.length,
    oldestCursor: events[0]?.seq ?? seq + 1,
    truncated: enabled && after < (events[0]?.seq ?? seq + 1) - 1,
    storageHealthy,
    restartCount,
  };
}
