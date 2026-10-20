import { serializeDetail, type DetailEvent } from './detailed-diagnostics';
const installed = Symbol.for('zylos.diagnostics.detailed-runtime');
type DetailTarget = typeof globalThis & { [installed]?: () => void };

export function installDetailedRuntime(
  emit: (event: DetailEvent) => void,
  enabled: () => boolean,
  secrets: () => string[] = () => [],
) {
  const target = globalThis as DetailTarget;
  target[installed]?.();
  let emitting = false;
  const report = (kind: DetailEvent['kind'], level: DetailEvent['level'], args: unknown[]) => {
    if (emitting) return;
    emitting = true;
    try {
      if (!enabled()) return;
      emit({ kind, level, at: Date.now(), ...serializeDetail(args, secrets()) });
    } catch {
      /* Best effort. */
    } finally {
      emitting = false;
    }
  };
  const restore: (() => void)[] = [];
  for (const level of ['debug', 'log', 'info', 'warn', 'error'] as const) {
    const original = console[level];
    const wrapper = function (this: unknown, ...args: unknown[]) {
      report('console', level, args);
      return Reflect.apply(original, this, args);
    };
    console[level] = wrapper;
    restore.push(() => {
      if (console[level] === wrapper) console[level] = original;
    });
  }
  const error = (event: ErrorEvent) => {
    try {
      report('error', 'error', [event.message, event.error]);
    } catch {
      /* Invalid event. */
    }
  };
  const rejection = (event: PromiseRejectionEvent) => {
    try {
      report('unhandledrejection', 'error', [event.reason]);
    } catch {
      /* Invalid event. */
    }
  };
  globalThis.addEventListener?.('error', error);
  globalThis.addEventListener?.('unhandledrejection', rejection);
  const dispose = () => {
    restore.forEach((fn) => fn());
    globalThis.removeEventListener?.('error', error);
    globalThis.removeEventListener?.('unhandledrejection', rejection);
    delete target[installed];
  };
  target[installed] = dispose;
  return dispose;
}
