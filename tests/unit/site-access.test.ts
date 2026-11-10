// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let saved: Record<string, unknown>;
let set: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
  saved = {};
  set = vi.fn(async (value: object) => {
    Object.assign(saved, structuredClone(value));
  });
  get = vi.fn(async () => structuredClone(saved));
  vi.stubGlobal('chrome', { storage: { local: { get, set } } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const load = () => import('../../utils/site-access');
async function ready() {
  const policy = await load();
  await policy.initializeSiteAccess('recipient-a');
  return policy;
}

describe('owner-managed site access', () => {
  it('defaults to the original blocklist and never treats an uninitialized grant as active', async () => {
    const p = await load();
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
    expect(p.isSiteUrlBlocked('https://example.com/article')).toBe(false);
    expect(() => p.assertSiteAction('https://example.com/billing', 'read-page')).toThrow(
      'BLOCKED_URL',
    );
    await expect(p.grantSiteAccess('https://example.com', 'interactive', 5)).rejects.toThrow(
      'SITE_ACCESS_NOT_READY',
    );
  });

  it('grants only an exact scheme, hostname and port', async () => {
    const p = await ready();
    await p.grantSiteAccess('https://example.com', 'read-only', 60);
    expect(p.isSiteUrlBlocked('https://example.com/billing?tab=wallet')).toBe(false);
    for (const url of [
      'http://example.com/billing',
      'https://sub.example.com/billing',
      'https://example.com:444/billing',
      'https://example.com.evil.test/billing',
      'https://user:password@example.com/billing',
    ])
      expect(p.isSiteUrlBlocked(url)).toBe(true);
  });

  it.each([
    'https://example.com/billing',
    'https://example.com/',
    '*.example.com',
    'https://*.example.com',
    'https://example.com?query=secret',
    'https://example.com#section',
    'https://user:secret@example.com',
    'file:///tmp/page',
    'javascript:alert(1)',
    'https://EXAMPLE.com',
    'https://example.com:443',
  ])('rejects ambiguous origin %s', async (origin) => {
    const p = await ready();
    await expect(p.grantSiteAccess(origin, 'interactive', 60)).rejects.toThrow();
    expect(p.siteAccessState().grants).toEqual([]);
  });

  it.each([0, 4, 1441, 5.5, NaN, Infinity])('rejects invalid duration %s', async (duration) => {
    const p = await ready();
    await expect(p.grantSiteAccess('https://example.com', 'read-only', duration)).rejects.toThrow();
    expect(set).not.toHaveBeenCalled();
  });

  it('allows only explicit read actions under a read-only grant, on every page at the origin', async () => {
    const p = await ready();
    await p.grantSiteAccess('https://example.com', 'read-only', 5);
    for (const action of [
      'read-page',
      'use-current-tab',
      'open',
      'new-tab',
      'switch-tab',
      'snapshot',
      'observe',
      'screenshot',
      'find',
      'inspect',
      'frames',
      'wait',
      'wait-for-page',
      'scroll',
      'tabs',
      'dialog-get',
      'finish',
      'pause',
      'stop',
      'close-tab',
      'finalize',
    ]) {
      expect(() => p.assertSiteAction('https://example.com/billing', action)).not.toThrow();
    }
    for (const action of [
      'click',
      'hover',
      'double-click',
      'fill',
      'type',
      'keypress',
      'select',
      'check',
      'back',
      'forward',
      'reload',
      'recover-control',
      'dialog',
      'new-action',
    ]) {
      expect(() => p.assertSiteAction('https://example.com/article', action)).toThrow(
        'SITE_READ_ONLY',
      );
    }
    expect(() => p.assertSiteAction('https://other.test/article', 'click')).not.toThrow();
  });

  it('interactive grants permit actions while other sites retain default denial', async () => {
    const p = await ready();
    await p.grantSiteAccess('https://example.com', 'interactive', 5);
    expect(() => p.assertSiteAction('https://example.com/billing', 'click')).not.toThrow();
    expect(() => p.assertSiteAction('https://other.test/billing', 'click')).toThrow('BLOCKED_URL');
  });

  it('expires at the exact boundary and keeps expired entries visible until replaced', async () => {
    const p = await ready();
    await p.grantSiteAccess('https://example.com', 'read-only', 5);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
    expect(p.siteAccessState().grants).toHaveLength(1);
  });

  it('restores grants only for the same recipient and skips future interactive grants', async () => {
    const p = await ready();
    await p.grantSiteAccess('https://example.com', 'interactive', 60);
    vi.resetModules();
    const restart = await load();
    await restart.initializeSiteAccess('recipient-a');
    expect(restart.isSiteUrlBlocked('https://example.com/billing')).toBe(false);
    await restart.initializeSiteAccess('recipient-b');
    expect(restart.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
    const data = saved[p.SITE_ACCESS_KEY] as { grants: { createdAt: number; expiresAt: number }[] };
    data.grants[0]!.createdAt = Date.now() + 1000;
    await restart.initializeSiteAccess('recipient-a');
    expect(restart.siteAccessState().grants).toEqual([]);
  });

  it('keeps restrictive rules after a clock rollback before and after restart', async () => {
    const p = await ready();
    await p.grantSiteAccess('example.com', 'denied', 60, 'domain');
    await p.grantSiteAccess('*.corp.test', 'read-only', 60, 'domain');
    vi.setSystemTime(Date.now() - 60_000);
    const verify = () => {
      expect(p.isSiteUrlBlocked('https://example.com/article')).toBe(true);
      expect(() => p.assertSiteAction('https://a.corp.test/article', 'click')).toThrow(
        'SITE_READ_ONLY',
      );
      expect(p.siteAccessState().grants).toHaveLength(2);
    };
    verify();
    await p.initializeSiteAccess('recipient-a');
    verify();
  });

  it('restores valid records independently and stores default decisions by stable id', async () => {
    const p = await ready();
    await p.grantSiteAccess('example.com', 'denied', 60, 'domain');
    await p.updateDefaultSiteRule('billing', false, 'denied');
    const data = saved[p.SITE_ACCESS_KEY] as {
      grants: unknown[];
      audit: unknown[];
      defaults: unknown[];
    };
    expect(data.defaults[0]).toEqual({ id: 'billing', enabled: false, mode: 'denied' });
    data.grants.push({ mode: 'interactive', origin: 'invalid' });
    data.audit.push({ at: 'invalid' });
    data.defaults.push({ id: 'banks', enabled: 'invalid', mode: 'interactive' });
    await p.initializeSiteAccess('recipient-a');
    expect(p.siteAccessState().grants).toHaveLength(1);
    expect(p.isSiteUrlBlocked('https://example.com/article')).toBe(true);
    expect(p.isSiteUrlBlocked('https://other.test/billing')).toBe(false);
    expect(p.isSiteUrlBlocked('https://online.usbank.com')).toBe(true);
    expect(p.siteAccessState().recoveryRequired).toBeUndefined();
  });

  it('merges legacy defaults by id even when labels or patterns changed', async () => {
    const p = await ready();
    const defaults = p.siteAccessState().defaults;
    defaults[0] = {
      ...defaults[0]!,
      label: 'Old billing label',
      pattern: 'old pattern',
      enabled: false,
    };
    saved[p.SITE_ACCESS_KEY] = { binding: 'recipient-a', grants: [], audit: [], defaults };
    await p.initializeSiteAccess('recipient-a');
    expect(p.siteAccessState().defaults[0]).toMatchObject({
      label: 'Billing and checkout',
      enabled: false,
    });
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(false);
  });

  it('fails closed for a corrupted restriction until the owner explicitly resets settings', async () => {
    const p = await ready();
    await p.grantSiteAccess('example.com', 'denied', 60, 'domain');
    const data = saved[p.SITE_ACCESS_KEY] as { grants: { expiresAt: unknown }[] };
    data.grants[0]!.expiresAt = 'corrupt';
    await p.initializeSiteAccess('recipient-a');
    expect(p.siteAccessState().recoveryRequired).toBe(true);
    expect(p.isSiteUrlBlocked('https://example.com/article')).toBe(true);
    expect(p.isSiteUrlBlocked('https://unrelated.test/article')).toBe(true);
    await expect(p.grantSiteAccess('https://example.com', 'interactive', 60)).rejects.toThrow(
      'SITE_ACCESS_RECOVERY_REQUIRED',
    );
    await expect(p.updateDefaultSiteRule('billing', false, 'denied')).rejects.toThrow(
      'SITE_ACCESS_RECOVERY_REQUIRED',
    );
    await p.revokeSiteAccess(crypto.randomUUID());
    expect(saved[p.SITE_ACCESS_KEY]).toMatchObject({ recoveryRequired: true });
    await p.initializeSiteAccess('recipient-a');
    expect(p.siteAccessState().recoveryRequired).toBe(true);
    await p.clearSiteAccess();
    expect(p.siteAccessState().recoveryRequired).toBeUndefined();
    expect(p.isSiteUrlBlocked('https://unrelated.test/article')).toBe(false);
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
    await p.initializeSiteAccess('recipient-a');
    expect(p.siteAccessState().recoveryRequired).toBeUndefined();
  });

  it('revokes immediately before persistence and does not revive grants on storage failure', async () => {
    const p = await ready();
    await p.grantSiteAccess('https://example.com', 'interactive', 60);
    const id = p.siteAccessState().grants[0]!.id;
    set.mockRejectedValueOnce(new Error('storage unavailable'));
    const result = p.revokeSiteAccess(id);
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
    await expect(result).rejects.toThrow('storage unavailable');
    expect(p.siteAccessState().grants).toEqual([]);
  });

  it('never enables a grant if its durable write fails', async () => {
    const p = await ready();
    set.mockRejectedValueOnce(new Error('disk full'));
    await expect(p.grantSiteAccess('https://example.com', 'interactive', 60)).rejects.toThrow(
      'disk full',
    );
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
    expect(p.siteAccessState().grants).toEqual([]);
  });

  it('loads fail closed when storage is unreadable or malformed', async () => {
    const p = await ready();
    await p.grantSiteAccess('https://example.com', 'interactive', 60);
    get.mockRejectedValueOnce(new Error('cannot read'));
    await expect(p.initializeSiteAccess('recipient-a')).rejects.toThrow('cannot read');
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
    expect(p.isSiteUrlBlocked('https://unrelated.test/article')).toBe(true);
    saved[p.SITE_ACCESS_KEY] = { binding: 'recipient-a', grants: 'wrong', audit: [] };
    await p.initializeSiteAccess('recipient-a');
    expect(p.siteAccessState().grants).toEqual([]);
    expect(p.siteAccessState().recoveryRequired).toBe(true);
    saved[p.SITE_ACCESS_KEY] = { binding: null, grants: [], audit: [] };
    await p.initializeSiteAccess('recipient-a');
    expect(p.isSiteUrlBlocked('https://unrelated.test/article')).toBe(true);
  });

  it('serializes independent grants and replaces an existing origin without duplicate grants', async () => {
    const p = await ready();
    await Promise.all([
      p.grantSiteAccess('https://example.com', 'read-only', 5),
      p.grantSiteAccess('https://other.test', 'interactive', 5),
    ]);
    expect(p.siteAccessState().grants).toHaveLength(2);
    await p.grantSiteAccess('https://example.com', 'interactive', 10);
    expect(p.siteAccessState().grants).toHaveLength(2);
    expect(() => p.assertSiteAction('https://example.com/billing', 'click')).not.toThrow();
  });

  it('clearing while a grant write is pending wins and repairs the saved state', async () => {
    const p = await ready();
    let resume: () => void = () => {};
    set.mockImplementationOnce(async (value: object) => {
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      Object.assign(saved, structuredClone(value));
    });
    const grant = p.grantSiteAccess('https://example.com', 'interactive', 5);
    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce());
    const clear = p.clearSiteAccess();
    resume();
    await expect(grant).rejects.toThrow('SITE_ACCESS_CHANGED');
    await clear;
    expect(p.siteAccessState().grants).toEqual([]);
    expect(saved[p.SITE_ACCESS_KEY]).toMatchObject({ grants: [], audit: [] });
  });

  it('records bounded access metadata without sensitive paths, queries or page content', async () => {
    const p = await ready();
    await p.recordSiteAccess('https://example.com/article', 'read-page', true);
    expect(p.siteAccessState().audit).toEqual([]);
    await p.recordSiteAccess(
      'https://example.com/billing?token=secret#private',
      'read-page',
      false,
    );
    await p.grantSiteAccess('https://example.com', 'read-only', 60);
    await p.recordSiteAccess('https://example.com/billing?token=secret', 'observe', true);
    expect(p.siteAccessState().audit).toMatchObject([
      { origin: 'https://example.com', action: 'read-page', allowed: false },
      { origin: 'https://example.com', action: 'grant', allowed: true, mode: 'read-only' },
      { origin: 'https://example.com', action: 'observe', allowed: true, mode: 'read-only' },
    ]);
    expect(JSON.stringify(p.siteAccessState().audit)).not.toMatch(/secret|private|token|billing/);
    for (let i = 0; i < 201; i++)
      await p.recordSiteAccess('https://example.com/billing', 'read-page', true);
    expect(p.siteAccessState().audit).toHaveLength(200);
    vi.advanceTimersByTime(7 * 24 * 60 * 60_000);
    expect(p.siteAccessState().audit).toEqual([]);
  });

  it('returns copies so panel consumers cannot alter active permission state', async () => {
    const p = await ready();
    await p.grantSiteAccess('https://example.com', 'read-only', 60);
    p.siteAccessState().grants[0]!.mode = 'interactive';
    expect(() => p.assertSiteAction('https://example.com/billing', 'click')).toThrow(
      'SITE_READ_ONLY',
    );
  });

  it('disables or changes a default through configuration without a hardcoded deny fallback', async () => {
    const p = await ready();
    expect(p.siteAccessState().defaults.find((rule) => rule.id === 'billing')!.mode).toBe('denied');
    await p.updateDefaultSiteRule('billing', false, 'denied');
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(false);
    expect(() => p.assertSiteAction('https://example.com/billing', 'click')).not.toThrow();
    await p.updateDefaultSiteRule('billing', true, 'read-only');
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(false);
    expect(() => p.assertSiteAction('https://example.com/billing', 'read-page')).not.toThrow();
    expect(() => p.assertSiteAction('https://example.com/billing', 'click')).toThrow(
      'SITE_READ_ONLY',
    );
    await p.initializeSiteAccess('recipient-a');
    expect(() => p.assertSiteAction('https://example.com/billing', 'click')).toThrow(
      'SITE_READ_ONLY',
    );
    await p.clearSiteAccess();
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
  });

  it('migrates older saved grants to exact-origin rules and initial default configuration', async () => {
    const p = await ready();
    await p.grantSiteAccess('https://example.com', 'interactive', 60);
    const data = saved[p.SITE_ACCESS_KEY] as { defaults?: unknown };
    delete data.defaults;
    await p.initializeSiteAccess('recipient-a');
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(false);
    expect(p.siteAccessState().grants[0]!.matchType).toBeUndefined();
    expect(
      p.siteAccessState().defaults.every((rule) => rule.enabled && rule.mode === 'denied'),
    ).toBe(true);
    expect(p.isSiteUrlBlocked('https://other.test/billing')).toBe(true);
  });

  it('uses the latest matching custom domain rule ahead of the configured defaults', async () => {
    const p = await ready();
    await p.grantSiteAccess('*.example.com', 'read-only', 60, 'domain');
    expect(p.isSiteUrlBlocked('https://api.example.com/billing')).toBe(false);
    expect(() => p.assertSiteAction('http://api.example.com:8080/article', 'click')).toThrow(
      'SITE_READ_ONLY',
    );
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
    await p.grantSiteAccess('^api\\.example\\.com$', 'denied', 60, 'domain-regex');
    expect(p.isSiteUrlBlocked('https://api.example.com/article')).toBe(true);
    expect(p.isSiteUrlBlocked('https://other.example.com/billing')).toBe(false);
    await p.grantSiteAccess('https://api.example.com', 'interactive', 60);
    expect(() => p.assertSiteAction('https://api.example.com/billing', 'click')).not.toThrow();
    expect(() => p.assertSiteAction('http://api.example.com/billing', 'click')).toThrow(
      'BLOCKED_URL',
    );
  });

  it('records actual matched origins rather than a domain regex or URL secret', async () => {
    const p = await ready();
    await p.grantSiteAccess('*.example.com', 'denied', 5, 'domain');
    await p.recordSiteAccess('https://a.example.com/billing?token=secret', 'read-page', false);
    expect(p.siteAccessState().audit).toMatchObject([
      { origin: 'https://a.example.com', mode: 'denied', allowed: false },
    ]);
    expect(JSON.stringify(p.siteAccessState().audit)).not.toMatch(/secret|token|\*|billing/);
  });

  it('applies restrictive default edits immediately even if persistence fails', async () => {
    const p = await ready();
    await p.updateDefaultSiteRule('billing', false, 'denied');
    set.mockRejectedValueOnce(new Error('disk unavailable'));
    const changing = p.updateDefaultSiteRule('billing', true, 'denied');
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
    await expect(changing).rejects.toThrow('disk unavailable');
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
    set.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(p.updateDefaultSiteRule('billing', false, 'denied')).rejects.toThrow(
      'disk unavailable',
    );
    expect(p.isSiteUrlBlocked('https://example.com/billing')).toBe(true);
  });
});
