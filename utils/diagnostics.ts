import { z } from 'zod';

export const DIAGNOSTICS_CAPABILITY = 'diagnostics-v1';
const KEY = 'remote-diagnostics-session';
export const DIAGNOSTICS_ENABLED_KEY = 'remote-diagnostics-enabled';
export const CAP = 200;
export const TTL = 30 * 60_000;
const eventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    at: z.number().finite(),
    event: z.enum(['enabled', 'detach', 'release', 'invalidate', 'stopped', 'socket-close']),
    reason: z
      .enum([
        'other',
        'target_closed',
        'canceled_by_user',
        'control_changed',
        'operation_changed',
        'grant_changed',
        'debugger_detach',
        'task_complete',
        'panel_stop',
        'config_disabled',
        'target_unavailable',
        'target_refresh_failed',
        'tab_scope_changed',
        'tab_lost',
        'window_closed',
        'pause_timeout',
        'command_stop',
        'finalize',
        'navigation',
        'target_attach',
        'target_detach',
        'release',
        'remote_disconnect',
      ])
      .optional(),
  })
  .strict();
export type DiagnosticEvent = z.infer<typeof eventSchema>;
export type DiagnosticReason = DiagnosticEvent['reason'];
export const diagnosticsQuery = z
  .object({
    after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(CAP).default(100),
  })
  .strict();
let enabled = false;
let seq = 0;
let dropped = 0;
let events: DiagnosticEvent[] = [];
let queue: Promise<unknown> = Promise.resolve();
let writing = false;
let dirty = false;
export const diagnosticsEnabled = () => enabled;
export function expireDiagnostics() {
  prune();
  persist();
}
function prune() {
  const kept = events.filter((e) => e.at > Date.now() - TTL).slice(-CAP);
  dropped += events.length - kept.length;
  events = kept;
}
function persist() {
  dirty = true;
  if (writing) return;
  writing = true;
  // Coalesce bursts: there is at most one storage write and one pending snapshot.
  queue = (async () => {
    try {
      while (dirty) {
        dirty = false;
        prune();
        await chrome.storage.session.set({ [KEY]: { seq, dropped, events } });
      }
    } finally {
      writing = false;
    }
  })();
  void queue.catch(() => {});
}
export async function initializeDiagnostics() {
  enabled = false;
  events = [];
  seq = 0;
  dropped = 0;
  const settings = await chrome.storage.local.get([DIAGNOSTICS_ENABLED_KEY]);
  enabled = settings[DIAGNOSTICS_ENABLED_KEY] === true;
  const saved = await chrome.storage.session.get(KEY);
  const parsed = z
    .object({
      seq: z.number().int().nonnegative(),
      dropped: z.number().int().nonnegative(),
      events: z.array(eventSchema).max(CAP),
    })
    .safeParse(saved[KEY]);
  if (parsed.success) {
    seq = parsed.data.seq;
    dropped = parsed.data.dropped;
    events = enabled ? parsed.data.events : [];
  }
  persist();
  await queue;
}
export async function setDiagnosticsEnabled(value: boolean) {
  // Disable synchronously so pending events/writes cannot restore cleared data.
  enabled = value;
  if (!value) {
    events = [];
    dropped = 0;
  }
  try {
    await chrome.storage.local.set({ [DIAGNOSTICS_ENABLED_KEY]: value });
  } catch (error) {
    enabled = false;
    events = [];
    persist();
    throw error;
  }
  if (value) recordDiagnostic('enabled');
  persist();
  await queue;
}
export function recordDiagnostic(event: DiagnosticEvent['event'], reason?: DiagnosticReason) {
  if (!enabled) return;
  const parsed = eventSchema.safeParse({
    seq: ++seq,
    at: Date.now(),
    event,
    ...(reason ? { reason } : {}),
  });
  if (!parsed.success) return;
  events.push(parsed.data);
  prune();
  persist();
}
export async function getDiagnostics(params: unknown) {
  const { after = 0, limit } = diagnosticsQuery.parse(params);
  await queue.catch(() => {});
  prune();
  persist();
  const result = enabled ? events.filter((e) => e.seq > after).slice(0, limit) : [];
  return {
    enabled,
    version: chrome.runtime.getManifest().version,
    events: result.map((e) => ({ ...e })),
    nextCursor: result.at(-1)?.seq ?? seq,
    dropped,
  };
}
