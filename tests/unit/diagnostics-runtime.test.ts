// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { installRuntimeDiagnostics } from '../../utils/diagnostics-runtime';
import { safeError, type PanelDiagnostic } from '../../utils/diagnostics-schema';

it('retains console behavior, prevents duplicate wrapping and suppresses all argument values', () => {
  const original = vi.fn((..._args: unknown[]) => 'original-result');
  const target = Object.assign(new EventTarget(), {
    console: {
      debug: original,
      info: original,
      log: original,
      warn: original,
      error: original,
    },
  });
  const events: PanelDiagnostic[] = [];
  const dispose = installRuntimeDiagnostics((event) => {
    events.push(event);
    target.console.debug('PRIVATE_RECURSION');
  }, target as any);
  expect(
    installRuntimeDiagnostics(() => {
      throw new Error('double wrapped');
    }, target as any),
  ).toBe(dispose);
  const secret = {
    nested: { token: 'PRIVATE_SECRET' },
    toJSON() {
      throw new Error('must not serialize');
    },
  };
  expect(target.console.error(secret, new Error('PRIVATE_ERROR'))).toBe('original-result');
  expect(original.mock.calls[0]?.[0]).toBe(secret);
  expect(events).toEqual([{ event: 'console', level: 'error', argCount: 2 }]);
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
  dispose();
  expect(target.console.error).toBe(original);
});

it('captures error classes and allowlisted codes without reading message, stack or code getters', () => {
  const target = Object.assign(new EventTarget(), {
    console: { debug() {}, info() {}, log() {}, warn() {}, error() {} },
  });
  const events: PanelDiagnostic[] = [];
  const dispose = installRuntimeDiagnostics((event) => events.push(event), target as any);
  const error = new TypeError('PRIVATE_MESSAGE');
  Object.defineProperty(error, 'stack', {
    get() {
      throw new Error('PRIVATE_STACK');
    },
  });
  Object.defineProperty(error, 'code', {
    get() {
      throw new Error('PRIVATE_CODE');
    },
  });
  const event = new Event('error');
  Object.defineProperty(event, 'error', { value: error });
  target.dispatchEvent(event);
  const rejection = new Event('unhandledrejection');
  Object.defineProperty(rejection, 'reason', {
    value: Object.assign(new Error('PRIVATE'), { code: 'STOPPED' }),
  });
  target.dispatchEvent(rejection);
  expect(events).toEqual([
    { event: 'runtime-error', level: 'error', errorKind: 'TypeError', code: 'OTHER' },
    { event: 'unhandled-rejection', level: 'error', errorKind: 'Error', code: 'STOPPED' },
  ]);
  expect(
    safeError(
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('PRIVATE_PROXY');
          },
        },
      ),
    ),
  ).toEqual({ errorKind: 'Other', code: 'OTHER' });
  dispose();
});
