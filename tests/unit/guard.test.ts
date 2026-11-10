// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBlockedUrl, screen } from '../../utils/guard';
import { initializeSiteAccess, updateDefaultSiteRule } from '../../utils/site-access';

beforeEach(async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => {} } } });
  await initializeSiteAccess('legacy-guard-tests');
});
afterEach(() => vi.unstubAllGlobals());

describe('url guard', () => {
  it('uses the current owner settings when a default is disabled', async () => {
    await updateDefaultSiteRule('billing', false, 'denied');
    expect(isBlockedUrl('https://example.com/billing')).toBe(false);
    expect(screen({ method: 'open', params: { url: 'https://example.com/billing' } })).toBeNull();
  });
  it.each([
    'https://shop.example/checkout',
    'https://shop.example/checkouts/c/abc123',
    'https://shop.example/checkout#step2',
    'https://shop.example/cart/checkout?x=1',
    'https://example.com/pay',
    'https://www.paypal.com/signin',
    'https://www.chase.com/',
    'https://online.usbank.com/login',
    'https://github.com/settings/security',
    'https://github.com/settings/ssh',
    'https://example.com/account/delete',
    'https://example.com/reset-password',
    'https://example.com/api-keys',
    'https://example.com/%63heckout',
    'https://example.com/%2563heckout',
    'https://www.coinbase.com/',
    'https://www.gemini.com/',
  ])('blocks %s', (url) => {
    expect(isBlockedUrl(url)).toBe(true);
  });

  it.each([
    'https://example.com/payment-guide',
    'https://example.com/payload',
    'https://gemini.google.com/app',
    'https://discover.corp.example/',
    'https://www.bilibili.com/video/BV1xx',
    'https://www.youtube.com/results?search_query=spider',
    'https://news.ycombinator.com/',
    '',
    undefined,
    42,
  ])('allows %s', (url) => {
    expect(isBlockedUrl(url)).toBe(false);
  });

  it('screens the task tab url and every string in params', () => {
    expect(screen({ method: 'click', tabUrl: 'https://www.chase.com/' })).toMatch(
      /blocklisted page/,
    );
    expect(screen({ method: 'open', params: { url: 'https://x.example/checkout' } })).toMatch(
      /params\.url/,
    );
    expect(
      screen({ method: 'open', params: { nested: [{ href: 'https://paypal.com/x' }] } }),
    ).toMatch(/params\.nested\[0\]\.href/);
    expect(screen({ method: 'snapshot', params: {}, tabUrl: 'https://example.com/' })).toBeNull();
  });

  it('fails closed on payloads it cannot finish walking', () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 12; i++) {
      cur.next = {};
      cur = cur.next as Record<string, unknown>;
    }
    expect(screen({ method: 'x', params: deep })).toMatch(/too large or too deeply nested/);
  });
});
