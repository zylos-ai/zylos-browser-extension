import { safeError, type PanelDiagnostic } from './diagnostics-schema';

const installed = Symbol.for('zylos.diagnostics.runtime');
type RuntimeTarget = typeof globalThis & { [installed]?: () => void };

/** Observe extension runtime failures without changing console or event behavior. */
export function installRuntimeDiagnostics(
  emit: (event: PanelDiagnostic) => void,
  target: RuntimeTarget = globalThis as RuntimeTarget,
) {
  if (target[installed]) return target[installed]!;
  let emitting = false;
  const safeEmit = (event: PanelDiagnostic) => {
    if (emitting) return;
    emitting = true;
    try {
      emit(event);
    } catch {
      /* Diagnostics cannot disrupt extension behavior. */
    } finally {
      emitting = false;
    }
  };
  const error = (event: Event) =>
    safeEmit({ event: 'runtime-error', level: 'error', ...safeError((event as ErrorEvent).error) });
  const rejection = (event: Event) =>
    safeEmit({
      event: 'unhandled-rejection',
      level: 'error',
      ...safeError((event as PromiseRejectionEvent).reason),
    });
  target.addEventListener?.('error', error);
  target.addEventListener?.('unhandledrejection', rejection);
  const levels = {
    debug: 'debug',
    log: 'info',
    info: 'info',
    warn: 'warn',
    error: 'error',
  } as const;
  const originals = new Map<keyof typeof levels, typeof console.log>();
  const wrappers = new Map<keyof typeof levels, typeof console.log>();
  for (const [name, level] of Object.entries(levels) as [
    keyof typeof levels,
    PanelDiagnostic['level'],
  ][]) {
    const original = target.console[name];
    const wrapper = function (this: unknown, ...args: unknown[]) {
      try {
        return Reflect.apply(original, this, args);
      } finally {
        safeEmit({ event: 'console', level, argCount: Math.min(args.length, 50) });
      }
    };
    originals.set(name, original);
    wrappers.set(name, wrapper);
    target.console[name] = wrapper;
  }
  const dispose = () => {
    target.removeEventListener?.('error', error);
    target.removeEventListener?.('unhandledrejection', rejection);
    for (const [name, original] of originals)
      if (target.console[name] === wrappers.get(name)) target.console[name] = original;
    delete target[installed];
  };
  target[installed] = dispose;
  return dispose;
}
