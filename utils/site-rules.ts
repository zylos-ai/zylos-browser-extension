import { z } from 'zod';

export const siteModeSchema = z.enum(['denied', 'read-only', 'interactive']);
export const siteMatchTypeSchema = z.enum(['origin', 'domain', 'domain-regex']);
export type SiteMode = z.infer<typeof siteModeSchema>;
export type SiteMatchType = z.infer<typeof siteMatchTypeSchema>;

// These are initial settings, not an additional runtime deny layer.
const seeds = [
  [
    'billing',
    'Billing and checkout',
    'url-regex',
    /\/(checkouts?|payments?|billing|cart\/checkout|pay)(?![a-z0-9_-])/i.source,
  ],
  [
    'payment-providers',
    'Payment providers',
    'url-regex',
    /\b(paypal|stripe|alipay|wechatpay|unionpay|klarna|afterpay|braintree|adyen)\b/i.source,
  ],
  ['banking', 'Banking URLs', 'url-regex', /\b(bank|banking|netbanking|onlinebanking)\b/i.source],
  [
    'account-security',
    'Account security',
    'url-regex',
    /\/(accounts?|settings|preferences|profile|users?|me)\/(security|password|passwd|payment|payments|billing|delete|close|2fa|mfa|otp|recovery)/i
      .source,
  ],
  [
    'account-access',
    'Account access management',
    'url-regex',
    /\/(accounts?|settings|preferences|profile|users?|me)\/(ssh|ssh[-_]?keys|gpg|gpg[-_]?keys|keys|emails?|phone|applications|authorized|connections|sessions|devices)/i
      .source,
  ],
  ['password-reset', 'Password reset', 'url-regex', /\/(change|reset|forgot)[-_]?password/i.source],
  [
    'security-settings',
    'Security and privacy settings',
    'url-regex',
    /\/(security|privacy)[-_]?settings/i.source,
  ],
  [
    'credentials',
    'API keys and credentials',
    'url-regex',
    /\/(api[-_]?keys|tokens|credentials|oauth\/authorize)(?![a-z0-9_-])/i.source,
  ],
  [
    'account-removal',
    'Account removal',
    'url-regex',
    /\/(delete|deactivate|close)[-_]?account/i.source,
  ],
  [
    'banks',
    'Bank domains',
    'host-regex',
    /(^|\.)(chase|wellsfargo|bankofamerica|citi|citibank|hsbc|barclays|lloyds|santander|usbank|pnc|capitalone|amex|americanexpress)\./i
      .source,
  ],
  [
    'financial-services',
    'Financial service domains',
    'host-regex',
    /(^|\.)(schwab|fidelity|vanguard|etrade|robinhood|interactivebrokers|revolut|wise|monzo|n26|paypal|stripe)\./i
      .source,
  ],
  [
    'regional-finance',
    'Regional finance domains',
    'host-regex',
    /(^|\.)(icbc|ccb|abchina|boc|bankcomm|bocom|cmbchina|spdb|psbc|pingan|alipay|antgroup)\./i
      .source,
  ],
  [
    'custodial-services',
    'Custodial service domains',
    'host-regex',
    /(^|\.)(binance|coinbase|kraken|okx|bybit|bitfinex|metamask|ledger|trezor)\./i.source,
  ],
  [
    'exact-finance',
    'Other financial domains',
    'host-regex',
    /(^|\.)(gemini|blockchain|discover)\.(com|info)$/i.source,
  ],
] as const;

export const defaultRuleSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(['url-regex', 'host-regex']),
    pattern: z.string(),
    enabled: z.boolean(),
    mode: siteModeSchema,
  })
  .strict()
  .refine(
    (rule) =>
      seeds.some(
        (seed) =>
          seed[0] === rule.id &&
          seed[1] === rule.label &&
          seed[2] === rule.kind &&
          seed[3] === rule.pattern,
      ),
    'Default rule identity or pattern changed',
  );
export type DefaultSiteRule = z.infer<typeof defaultRuleSchema>;
export function defaultSiteRules(): DefaultSiteRule[] {
  return seeds.map(([id, label, kind, pattern]) => ({
    id,
    label,
    kind,
    pattern,
    enabled: true,
    mode: 'denied',
  }));
}
export const defaultRulesSchema = z
  .array(defaultRuleSchema)
  .max(seeds.length)
  .refine(
    (rules) =>
      rules.length === seeds.length && new Set(rules.map((rule) => rule.id)).size === seeds.length,
    'Default rule set is incomplete',
  )
  .default(defaultSiteRules);

export function pageUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hostname.includes('*')
    ) {
      url.hostname = url.hostname.replace(/\.$/, '');
      return url;
    }
  } catch {
    /* Invalid URLs do not acquire a custom rule. */
  }
}

function validDomain(value: string): boolean {
  if (!value || value.length > 253 || value !== value.toLowerCase()) return false;
  if (!value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    return false;
  const url = pageUrl(`https://${value}`);
  return url?.hostname === value;
}

// A deliberately small regex grammar: literals, escaped dots/hyphens, character
// classes and at most one star. Anchored hostname matching bounds the input too.
export function validDomainRegex(pattern: string): boolean {
  if (pattern.length > 256 || !pattern.startsWith('^') || !pattern.endsWith('$')) return false;
  let stars = 0,
    suffix = '',
    i = 1;
  const end = pattern.length - 1;
  while (i < end) {
    let literal = '';
    const char = pattern[i]!;
    if (/[a-z0-9-]/.test(char)) {
      literal = char;
      i++;
    } else if (char === '\\' && ['.', '-'].includes(pattern[i + 1] || '')) {
      literal = pattern[i + 1]!;
      i += 2;
    } else if (char === '.' && pattern[i + 1] === '*') {
      if (++stars > 1) return false;
      suffix = '';
      i += 2;
      continue;
    } else if (char === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0 || close >= end) return false;
      const content = pattern.slice(i + 1, close);
      if (!content || !/^(?:a-z|0-9|[a-z0-9]|\\?-)+$/.test(content)) return false;
      i = close + 1;
      if (pattern[i] === '*') {
        if (++stars > 1) return false;
        i++;
      }
      suffix = '';
      continue;
    } else return false;
    if (pattern[i] === '*') {
      if (++stars > 1) return false;
      i++;
      suffix = '';
    } else suffix += literal;
  }
  const domainSuffix = suffix.replace(/^\./, '');
  if (stars && !suffix.startsWith('.')) return false;
  if (!validDomain(domainSuffix) || domainSuffix.split('.').length < 2) return false;
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

export function validSitePattern(pattern: string, type: SiteMatchType): boolean {
  if (type === 'origin') return pageUrl(pattern)?.origin === pattern;
  if (type === 'domain-regex') return validDomainRegex(pattern);
  const domain = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
  return validDomain(domain) && (!pattern.startsWith('*.') || domain.split('.').length >= 2);
}

export function matchesSitePattern(value: unknown, pattern: string, type: SiteMatchType): boolean {
  const url = pageUrl(value);
  if (!url) return false;
  if (type === 'origin') return url.origin === pattern;
  const host = url.hostname.toLowerCase();
  if (host.length > 253) return false;
  if (type === 'domain-regex')
    return validDomainRegex(pattern) && new RegExp(pattern, 'i').test(host);
  return pattern.startsWith('*.')
    ? host.endsWith(`.${pattern.slice(2)}`) && host !== pattern.slice(2)
    : host === pattern;
}

function decodeVariants(value: string) {
  const out = [value];
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(out.at(-1)!);
      if (decoded === out.at(-1)) break;
      out.push(decoded);
    } catch {
      break;
    }
  }
  return out;
}
function hostOf(value: string) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(value);
  return (
    match?.[1]
      ?.replace(/^[^@]*@/, '')
      .replace(/:\d+$/, '')
      .replace(/\.$/, '')
      .toLowerCase() || ''
  );
}
export function matchingDefaultRule(
  value: unknown,
  rules: readonly DefaultSiteRule[],
): DefaultSiteRule | undefined {
  if (typeof value !== 'string' || !value) return;
  const rank = { interactive: 0, 'read-only': 1, denied: 2 };
  let found: DefaultSiteRule | undefined;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const regex = new RegExp(rule.pattern, 'i');
    if (
      decodeVariants(value).some((url) =>
        regex.test(rule.kind === 'host-regex' ? hostOf(url) : url),
      ) &&
      (!found || rank[rule.mode] > rank[found.mode])
    )
      found = rule;
  }
  return found;
}
