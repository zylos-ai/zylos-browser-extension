import { z } from 'zod';

export const diagnosticLevel = z.enum(['debug', 'info', 'warn', 'error']);
export const diagnosticSource = z.enum(['background', 'sidepanel', 'executor']);
export const diagnosticEventName = z.enum([
  'enabled',
  'detach',
  'release',
  'invalidate',
  'stopped',
  'socket-close',
  'runtime-error',
  'unhandled-rejection',
  'console',
  'task-start',
  'task-end',
  'task-cancel',
  'operation-start',
  'operation-result',
  'operation-error',
  'transport-connect',
  'transport-open',
  'transport-ready',
  'transport-error',
  'request',
  'response',
  'storage-error',
  'worker-start',
  'capture-overflow',
]);
export const diagnosticReason = z.enum([
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
]);
export const diagnosticMethod = z.enum([
  'open',
  'new-tab',
  'switch-tab',
  'tabs',
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
  'wait-for-page',
  'dialog',
  'close-tab',
  'finalize',
  'read-page',
  'use-current-tab',
  'record-findings',
  'read-findings',
  'agent-decision',
  'diagnostics.get',
  'other',
]);
export const diagnosticCode = z.enum([
  'OTHER',
  'STORAGE_READ_FAILED',
  'STORAGE_WRITE_FAILED',
  'BAD_PARAMS',
  'UNKNOWN_METHOD',
  'PROTOCOL_MISMATCH',
  'SOCKET_ERROR',
  'INVALID_RELAY',
  'STOPPED',
  'PAGE_CHANGED',
  'COMMAND_EXPIRED',
  'CONTROL_NOT_GRANTED',
  'NO_CONTROLLABLE_TAB',
  'TASK_TAB_UNAVAILABLE',
  'TAB_NOT_GRANTED',
  'DEBUGGER_DETACH_FAILED',
  'EXT_ERROR',
  'BAD_DECISION',
  'DIAGNOSTICS_RESET',
  'BLOCKED_URL',
  'DIALOG_OPEN',
  'FRAME_UNAVAILABLE',
  'INVALID_TASK_SOURCE',
  'INVALID_URL',
  'NO_DIALOG',
  'NO_HISTORY_ENTRY',
  'OBSERVATION_UNAVAILABLE',
  'PAGE_LOADING',
  'SCREENSHOT_TOO_LARGE',
  'STALE_TASK',
  'TAB_UNAVAILABLE',
  'TASK_TAB_LIMIT',
  'UNSUPPORTED_PAGE',
  'UNSUPPORTED_WINDOW',
  'NO_WINDOW',
  'SENSITIVE_INPUT',
  'REQUEST_ID_CONFLICT',
  'PAGE_CONTENT_CHANGED',
]);
export const diagnosticErrorKind = z.enum([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'Other',
]);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const diagnosticMetadata = z
  .object({
    source: diagnosticSource.default('background'),
    level: diagnosticLevel.default('info'),
    reason: diagnosticReason.optional(),
    task: integer.optional(),
    op: integer.optional(),
    method: diagnosticMethod.optional(),
    code: diagnosticCode.optional(),
    errorKind: diagnosticErrorKind.optional(),
    argCount: z.number().int().min(0).max(50).optional(),
    count: z.number().int().min(1).max(1000000).optional(),
    closeCode: z.number().int().min(1000).max(4999).optional(),
    status: z
      .enum(['success', 'error', 'cancelled', 'done', 'blocked', 'stopped', 'interrupted'])
      .optional(),
  })
  .strict();
export const diagnosticEventSchema = diagnosticMetadata
  .extend({
    seq: integer,
    at: z.number().finite(),
    event: diagnosticEventName,
  })
  .strict();
export const panelDiagnosticSchema = diagnosticMetadata
  .omit({
    source: true,
    task: true,
    op: true,
    reason: true,
    method: true,
    closeCode: true,
    status: true,
  })
  .extend({
    event: z.enum(['runtime-error', 'unhandled-rejection', 'console', 'capture-overflow']),
  })
  .strict();
export const diagnosticsQuery = z
  .object({
    after: integer.optional(),
    limit: z.number().int().min(1).max(200).default(100),
    epoch: z.string().uuid().optional(),
    through: integer.optional(),
    level: diagnosticLevel.optional(),
    source: diagnosticSource.optional(),
    task: integer.optional(),
  })
  .strict();
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;
export type DiagnosticReason = z.infer<typeof diagnosticReason>;
export type DiagnosticMetadata = z.input<typeof diagnosticMetadata>;
export type PanelDiagnostic = z.infer<typeof panelDiagnosticSchema>;

// Read no message, stack, nested object, or getter. Console arguments are never serialized.
export function safeError(error: unknown): Pick<DiagnosticEvent, 'errorKind' | 'code'> {
  try {
    const kind =
      error instanceof TypeError
        ? 'TypeError'
        : error instanceof RangeError
          ? 'RangeError'
          : error instanceof SyntaxError
            ? 'SyntaxError'
            : error instanceof ReferenceError
              ? 'ReferenceError'
              : error instanceof URIError
                ? 'URIError'
                : error instanceof EvalError
                  ? 'EvalError'
                  : error instanceof AggregateError
                    ? 'AggregateError'
                    : error instanceof Error
                      ? 'Error'
                      : 'Other';
    const raw =
      error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value
        : undefined;
    const code = diagnosticCode.safeParse(raw);
    return { errorKind: kind, code: code.success ? code.data : 'OTHER' };
  } catch {
    return { errorKind: 'Other', code: 'OTHER' };
  }
}
