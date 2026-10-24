// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DetailedCapture,
  DETAIL_BYTES,
  DETAIL_TTL,
  FROZEN_DETAIL_TTL,
  FROZEN_DETAIL_BYTES,
  serializeDetail,
  redactDetail,
} from '../../utils/detailed-diagnostics';
import { installDetailedRuntime } from '../../utils/detailed-runtime';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.17.0' }) } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const event = (text = 'message') => ({
  kind: 'console',
  level: 'log',
  at: Date.now(),
  text,
  truncated: false,
});

it('defaults off, uses fresh consent and purges at expiry or explicit disable', async () => {
  const capture = new DetailedCapture(() => {});
  expect(capture.state().enabled).toBe(false);
  expect(capture.append('old', 'background', event())).toBe(false);
  const first = capture.enable().consent;
  capture.append(first, 'background', event());
  expect(capture.preview(first).records).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(DETAIL_TTL);
  expect(capture.state()).toMatchObject({ enabled: false, count: 0, bytes: 0 });
  expect(() => capture.preview(first)).toThrow();
  const next = capture.enable().consent;
  expect(next).not.toBe(first);
  expect(capture.append(first, 'sidepanel', event('stale'))).toBe(false);
  capture.clear();
  expect(capture.valid(next)).toBe(false);
  expect(new DetailedCapture(() => {}).state().enabled).toBe(false);
});

it('bounds retained bytes and event count and reports drops, truncation and correlation', () => {
  const capture = new DetailedCapture(() => {});
  const token = capture.enable().consent;
  for (let i = 0; i < 1100; i++)
    capture.append(
      token,
      'background',
      { ...event('word '.repeat(1500)), truncated: true },
      { task: 3, operation: 7 },
    );
  expect(capture.state().bytes).toBeLessThanOrEqual(DETAIL_BYTES);
  expect(capture.state().count).toBeLessThanOrEqual(1000);
  expect(capture.state().dropped).toBeGreaterThan(0);
  const output = capture.preview(token);
  expect(output.partial).toBe(true);
  expect(output.truncated).toBe(1100);
  expect(output.records.at(-1)).toMatchObject({
    task: 3,
    operation: 7,
    source: 'background',
    sequence: 1100,
  });
  output.records.length = 0;
  expect(capture.preview(token).records.length).toBeGreaterThan(0);
});

it('retains a frozen fault after capture expiry without extending collection or sharing consent', async () => {
  const changes = vi.fn();
  const capture = new DetailedCapture(changes);
  expect(capture.freeze('missing', {})).toBe(false);
  const token = capture.enable().consent;
  capture.append(token, 'background', event('fault'));
  const snapshot = {
    capture: capture.preview(token),
    incidents: [{ reason: 'target_closed' }],
    limitations: ['existing'],
  };
  // Remote validates the v1 capture field set exactly.
  expect(Object.keys(snapshot.capture)).not.toEqual(
    expect.arrayContaining(['exportExpiresAt', 'frozenAt', 'frozenCount', 'consent']),
  );
  expect(capture.freeze(token, snapshot)).toBe(true);
  const exported = capture.exportContext();
  expect(exported.consent).not.toBe(token);
  snapshot.capture.records[0]!.text = 'mutated';
  await vi.advanceTimersByTimeAsync(DETAIL_TTL);
  expect(capture.state()).toMatchObject({ enabled: false, consent: '', count: 0, frozenCount: 1 });
  expect(capture.valid(token)).toBe(false);
  expect(capture.append(token, 'background', event('late'))).toBe(false);
  expect(capture.append(exported.consent, 'background', event('export token'))).toBe(false);
  expect(capture.freeze(exported.consent, {})).toBe(false);
  expect(capture.validExport(exported.consent)).toBe(true);
  const frozen = capture.frozenPreview(exported.consent) as any;
  expect(frozen).toMatchObject({ capture: { records: [{ text: 'fault' }] } });
  expect(frozen.retention).toBeUndefined();
  expect(frozen.limitations[0]).toBe('existing');
  expect(frozen.limitations[1]).toContain(new Date(exported.expiresAt!).toISOString());
  expect(changes).toHaveBeenCalledWith('capture-expired');
  await vi.advanceTimersByTimeAsync(FROZEN_DETAIL_TTL - DETAIL_TTL);
  expect(capture.validExport(exported.consent)).toBe(false);
  expect(() => capture.frozenPreview(exported.consent)).toThrow();
});

it('bounds immutable frozen evidence and revokes previous export tokens on replacement and clear', () => {
  const capture = new DetailedCapture(() => {});
  const token = capture.enable().consent;
  expect(capture.freeze(token, { capture: { records: [] } })).toBe(true);
  const first = capture.exportContext().consent;
  expect(capture.freeze(token, { text: 'x'.repeat(FROZEN_DETAIL_BYTES) })).toBe(false);
  expect(capture.validExport(first)).toBe(true);
  expect(capture.freeze(token, { capture: { records: ['new'] } })).toBe(true);
  expect(capture.validExport(first)).toBe(false);
  const second = capture.exportContext().consent;
  capture.clear();
  expect(capture.validExport(second)).toBe(false);
  const third = capture.enable().consent;
  capture.freeze(third, { capture: { records: [] } });
  const fourth = capture.exportContext().consent;
  capture.enable();
  expect(capture.validExport(fourth)).toBe(false);
});

it('does not invoke object getters/toJSON and marks opaque, cyclic and revoked objects omitted', () => {
  const getter = vi.fn(() => {
    throw new Error('getter ran');
  });
  const object = {
    toJSON: getter,
    get private() {
      return getter();
    },
    self: undefined as unknown,
  };
  object.self = object;
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [object, revoked.proxy, () => 1, Symbol('secret')]) {
    const result = serializeDetail([value]);
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/omitted|uninspectable/);
  }
  const cyclic: object = new Proxy({}, { getPrototypeOf: (): object => cyclic });
  expect(serializeDetail([cyclic]).truncated).toBe(true);
  expect(getter).not.toHaveBeenCalled();
});

it('retains Error own message/stack but never reads an accessor override', () => {
  const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, value: undefined });
  try {
    const error = new Error('actual failure');
    Object.defineProperty(error, 'stack', {
      value: 'Error: actual failure\n at extension.js:42',
      configurable: true,
    });
    expect(serializeDetail([error]).text).toContain('extension.js:42');
    const get = vi.fn(() => 'SECRET');
    Object.defineProperty(error, 'stack', { get });
    expect(serializeDetail([error])).toMatchObject({ truncated: true });
    expect(get).not.toHaveBeenCalled();
  } finally {
    if (formatter) Object.defineProperty(Error, 'prepareStackTrace', formatter);
    else Reflect.deleteProperty(Error, 'prepareStackTrace');
  }
});

it('redacts known keys before truncation and handles recognizable text credentials', () => {
  const secret = 'a'.repeat(64);
  const result = serializeDetail(['prefix '.repeat(1169) + secret + ' suffix'], [secret]);
  expect(result.text).not.toContain('a'.repeat(16));
  expect(
    redactDetail(
      'Authorization: Bearer secretvalue password="private" {"api_key":"hidden"} https://u:p@example.com/path?token=secret#private',
    ),
  ).not.toMatch(/secretvalue|private|hidden|u:p|token=/);
  const capture = new DetailedCapture(
    () => {},
    () => [secret],
  );
  const token = capture.enable().consent;
  capture.append(token, 'sidepanel', event(`key ${secret}`));
  expect(JSON.stringify(capture.preview(token))).not.toContain(secret);
  expect(serializeDetail(['x'.repeat(1000000)]).truncated).toBe(true);
});
it('never invokes custom error formatters or name/message getters for stack capture', () => {
  const custom = vi.fn(() => 'PRIVATE_FORMATTER');
  const previous = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  const error = new Error('failure');
  try {
    Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, value: custom });
    expect(serializeDetail([error]).truncated).toBe(true);
    expect(custom).not.toHaveBeenCalled();
  } finally {
    if (previous) Object.defineProperty(Error, 'prepareStackTrace', previous);
    else Reflect.deleteProperty(Error, 'prepareStackTrace');
  }
  for (const key of ['name', 'message']) {
    const value = new Error('failure');
    Object.defineProperty(value, key, { get: custom });
    expect(serializeDetail([value]).truncated).toBe(true);
  }
  expect(custom).not.toHaveBeenCalled();
});

it('captures only when enabled and restores console behavior without recursive emission', () => {
  let enabled = false;
  const original = vi.spyOn(console, 'log').mockImplementation(() => {});
  const emit = vi.fn();
  const dispose = installDetailedRuntime(emit, () => enabled);
  console.log('before');
  expect(emit).not.toHaveBeenCalled();
  enabled = true;
  console.log('after');
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ text: 'after', kind: 'console' }));
  dispose();
  console.log('disposed');
  expect(emit).toHaveBeenCalledTimes(1);
  expect(original).toHaveBeenCalledTimes(3);
});
