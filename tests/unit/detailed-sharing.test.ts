// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { DetailedSharing, SHARE_BYTES, SHARE_TTL } from '../../utils/detailed-sharing';

const context = () => ({
  consent: crypto.randomUUID(),
  expiresAt: Date.now() + 600_000,
  generation: 2,
  recipient: 'wss://remote.example/ext',
  connected: true,
});
afterEach(() => vi.useRealTimers());
it('requires separate explicit grant and returns exact immutable preview only once', async () => {
  const sharing = new DetailedSharing(),
    ctx = context();
  const snapshot = { records: ['before'] };
  const prepared = await sharing.prepare(snapshot, ctx);
  snapshot.records.push('after');
  sharing.grant(prepared.id, ctx);
  expect(sharing.state().phase).toBe('authorized');
  expect(sharing.fetch(ctx)).toEqual({
    schemaVersion: 1,
    text: prepared.text,
    sha256: prepared.sha256,
  });
  expect(prepared.text).not.toContain('after');
  expect(() => sharing.fetch(ctx)).toThrow();
  expect(sharing.state().phase).toBe('consumed');
  expect(() => sharing.grant(prepared.id, ctx)).toThrow();
});
it('preparation alone never authorizes retrieval', async () => {
  const sharing = new DetailedSharing(),
    ctx = context();
  await sharing.prepare({}, ctx);
  expect(() => sharing.fetch(ctx)).toThrow();
});
it.each(['consent', 'generation', 'recipient', 'connected'] as const)(
  'invalidates when %s changes after preview or grant',
  async (key) => {
    const sharing = new DetailedSharing(),
      ctx = context();
    const prepared = await sharing.prepare({}, ctx);
    const changed = {
      ...ctx,
      [key]:
        key === 'generation'
          ? 3
          : key === 'connected'
            ? false
            : key === 'recipient'
              ? 'wss://other.example/ext'
              : crypto.randomUUID(),
    };
    expect(() => sharing.grant(prepared.id, changed)).toThrow();
    sharing.grant(prepared.id, ctx);
    expect(() => sharing.fetch(changed)).toThrow();
    expect(() => sharing.fetch(ctx)).toThrow();
  },
);
it('rejects insecure transport and oversized snapshots', async () => {
  const sharing = new DetailedSharing(),
    ctx = context();
  await expect(sharing.prepare({}, { ...ctx, recipient: 'ws://localhost/ext' })).rejects.toThrow();
  await expect(sharing.prepare({ text: 'x'.repeat(SHARE_BYTES) }, ctx)).rejects.toThrow();
});
it('revokes explicitly and at min(two minutes, capture expiry)', async () => {
  vi.useFakeTimers();
  for (const duration of [1000, 600_000]) {
    const sharing = new DetailedSharing(),
      ctx = { ...context(), expiresAt: Date.now() + duration };
    const prepared = await sharing.prepare({}, ctx);
    sharing.grant(prepared.id, ctx);
    await vi.advanceTimersByTimeAsync(Math.min(duration, SHARE_TTL));
    expect(() => sharing.fetch(ctx)).toThrow();
  }
  const sharing = new DetailedSharing(),
    ctx = context();
  const prepared = await sharing.prepare({}, ctx);
  sharing.grant(prepared.id, ctx);
  sharing.revoke();
  expect(() => sharing.fetch(ctx)).toThrow();
  expect(sharing.state().phase).toBe('revoked');
});

it('discarding a preview while hashing cannot resurrect it', async () => {
  const sharing = new DetailedSharing(),
    ctx = context();
  let complete!: (buffer: ArrayBuffer) => void;
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  try {
    const pending = sharing.prepare({}, ctx);
    sharing.revoke();
    complete(new ArrayBuffer(32));
    await expect(pending).rejects.toThrow();
    expect(sharing.state().phase).toBe('revoked');
    expect(() => sharing.fetch(ctx)).toThrow();
  } finally {
    digest.mockRestore();
  }
});
