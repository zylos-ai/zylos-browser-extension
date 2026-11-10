// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  defaultRulesSchema,
  defaultSiteRules,
  matchingDefaultRule,
  matchesSitePattern,
  validSitePattern,
} from '../../utils/site-rules';

describe('site rule patterns', () => {
  it('matches exact domains across schemes and ports without suffix confusion', () => {
    expect(validSitePattern('example.com', 'domain')).toBe(true);
    for (const url of ['https://example.com/billing', 'http://example.com:8080/a'])
      expect(matchesSitePattern(url, 'example.com', 'domain')).toBe(true);
    for (const url of [
      'https://sub.example.com',
      'https://example.com.evil.test',
      'https://evil.test/?to=example.com',
      'https://user:pass@example.com',
    ])
      expect(matchesSitePattern(url, 'example.com', 'domain')).toBe(false);
  });

  it('wildcards match subdomains only and reject overly broad or ambiguous patterns', () => {
    expect(validSitePattern('*.example.com', 'domain')).toBe(true);
    expect(
      matchesSitePattern('https://a.b.example.com:8443/billing', '*.example.com', 'domain'),
    ).toBe(true);
    expect(matchesSitePattern('https://example.com', '*.example.com', 'domain')).toBe(false);
    expect(matchesSitePattern('https://a.example.com.evil.test', '*.example.com', 'domain')).toBe(
      false,
    );
    for (const pattern of [
      '*',
      '*.com',
      'https://*.example.com',
      'example.com/path',
      'example.com:443',
      'foo.*.com',
      '*.example.com.',
      'EXAMPLE.com',
    ])
      expect(validSitePattern(pattern, 'domain')).toBe(false);
  });

  it('supports punycode and canonical hostname casing in URLs', () => {
    expect(validSitePattern('xn--bcher-kva.example', 'domain')).toBe(true);
    expect(
      matchesSitePattern('https://BÜCHER.example/billing', 'xn--bcher-kva.example', 'domain'),
    ).toBe(true);
  });

  it.each([
    ['https://example.com./', 'example.com', 'domain'],
    ['https://a.corp.test.:8443/', '*.corp.test', 'domain'],
    ['https://x.regex.test./', '^.*\\.regex\\.test$', 'domain-regex'],
    ['https://origin.test.:8443/', 'https://origin.test:8443', 'origin'],
  ] as const)('canonicalizes a DNS root dot before matching %s', (url, pattern, type) => {
    expect(matchesSitePattern(url, pattern, type)).toBe(true);
  });

  it('accepts bounded hostname regex syntax and tests only the actual hostname', () => {
    const pattern = '^[a-z0-9-]*\\.example\\.com$';
    expect(validSitePattern(pattern, 'domain-regex')).toBe(true);
    expect(
      matchesSitePattern('https://api-3.example.com:8443/billing', pattern, 'domain-regex'),
    ).toBe(true);
    expect(
      matchesSitePattern('https://evil.test/?next=api.example.com', pattern, 'domain-regex'),
    ).toBe(false);
    expect(matchesSitePattern('https://api.example.com.evil.test', pattern, 'domain-regex')).toBe(
      false,
    );
    expect(validSitePattern('^.*\\.example\\.com$', 'domain-regex')).toBe(true);
    expect(validSitePattern('^example\\.com$', 'domain-regex')).toBe(true);
  });

  it.each([
    'example\\.com',
    '^.*$',
    '^.*example\\.com$',
    '^.*e\\.com$',
    '^[a-z]*example\\.com$',
    '^.*\\.com$',
    '/^example\\.com$/i',
    '^(a+)+\\.example\\.com$',
    '^(foo|bar)\\.example\\.com$',
    '^(?=api)api\\.example\\.com$',
    '^a{1,5}\\.example\\.com$',
    '^a+\\.example\\.com$',
    '^a?\\.example\\.com$',
    '^a\\1\\.example\\.com$',
    '^.*.*\\.example\\.com$',
    '^[^a]*\\.example\\.com$',
    '^a\\.example\\.com$/g',
  ])('rejects unbounded or unsupported regex %s', (pattern) => {
    expect(validSitePattern(pattern, 'domain-regex')).toBe(false);
  });

  it('initial default settings preserve encoded URL and host patterns', () => {
    const rules = defaultSiteRules();
    expect(matchingDefaultRule('https://example.com/%2562illing', rules)?.id).toBe('billing');
    expect(matchingDefaultRule('https://online.usbank.com', rules)?.id).toBe('banks');
    expect(matchingDefaultRule('https://gemini.com./', rules)?.id).toBe('exact-finance');
    expect(matchingDefaultRule('https://example.com/payment-guide', rules)).toBeUndefined();
  });

  it.each([
    ['https://shop.example/check\tout', 'billing'],
    ['https://example.com/oauth/author\nize', 'credentials'],
    ['https://ch\nase.com', 'banks'],
    ['https://chase。com', 'banks'],
    ['https://gemini.com\\x', 'exact-finance'],
  ])('screens canonical navigation URL %s before navigating', (url, id) => {
    const rules = defaultSiteRules();
    expect(matchingDefaultRule(url, rules)?.id).toBe(id);
    rules.find((rule) => rule.id === id)!.enabled = false;
    expect(matchingDefaultRule(url, rules)).toBeUndefined();
  });

  it('disabled defaults have no hidden fallback and overlap uses the most restrictive mode', () => {
    const rules = defaultSiteRules();
    rules.find((rule) => rule.id === 'billing')!.enabled = false;
    expect(matchingDefaultRule('https://example.com/billing', rules)).toBeUndefined();
    rules.find((rule) => rule.id === 'billing')!.enabled = true;
    rules.find((rule) => rule.id === 'billing')!.mode = 'interactive';
    expect(matchingDefaultRule('https://stripe.com/billing', rules)?.mode).toBe('denied');
  });

  it('stored default configuration can edit decisions but not inject patterns or omit rules', () => {
    const rules = defaultSiteRules();
    rules[0]!.enabled = false;
    rules[1]!.mode = 'read-only';
    expect(defaultRulesSchema.safeParse(rules).success).toBe(true);
    expect(defaultRulesSchema.parse(undefined)).toHaveLength(rules.length);
    expect(defaultRulesSchema.safeParse(rules.slice(1)).success).toBe(false);
    expect(
      defaultRulesSchema.safeParse(rules.map((rule) => ({ ...rule, pattern: '.*' }))).success,
    ).toBe(false);
  });
});
