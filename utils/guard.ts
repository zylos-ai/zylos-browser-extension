// URL blocklist. Ported from zylos-browser-remote/extension/guard.js (the
// adversarially reviewed cdp-bridge original). The relay no longer carries a
// copy: this is the ONLY gate, and it runs against live tab URLs, hrefs and
// navigation targets -- things a relay-side cache could never see.

// Hosts/paths that must never be driven without a per-case go-ahead from the owner.
// Matching is intentionally broad: a false refusal is cheap, a wrong click is not.
const BLOCKED_URL_PATTERNS: readonly RegExp[] = Object.freeze([
  // payment / checkout / banking. A negative lookahead terminates on ANY
  // non-word character so /checkout#step2 and /checkout;jsessionid=.. match,
  // while /payment-guide and /payload do not. Pluralised so Shopify's real
  // /checkouts/c/<token> path matches.
  /\/(checkouts?|payments?|billing|cart\/checkout|pay)(?![a-z0-9_-])/i,
  /\b(paypal|stripe|alipay|wechatpay|unionpay|klarna|afterpay|braintree|adyen)\b/i,
  /\b(bank|banking|netbanking|onlinebanking)\b/i,
  // account + security settings
  /\/(accounts?|settings|preferences|profile|users?|me)\/(security|password|passwd|payment|payments|billing|delete|close|2fa|mfa|otp|recovery)/i,
  // account-takeover-equivalent surfaces: key/email/session/app management
  /\/(accounts?|settings|preferences|profile|users?|me)\/(ssh|ssh[-_]?keys|gpg|gpg[-_]?keys|keys|emails?|phone|applications|authorized|connections|sessions|devices)/i,
  /\/(change|reset|forgot)[-_]?password/i,
  /\/(security|privacy)[-_]?settings/i,
  /\/(api[-_]?keys|tokens|credentials|oauth\/authorize)(?![a-z0-9_-])/i,
  // destructive account actions
  /\/(delete|deactivate|close)[-_]?account/i,
]);

// Financial / custodial hostnames. The \b(bank)\b path pattern misses every real
// bank domain ("chase.com", "usbank.com"), so hosts are screened separately.
const BLOCKED_HOST_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|\.)(chase|wellsfargo|bankofamerica|citi|citibank|hsbc|barclays|lloyds|santander|usbank|pnc|capitalone|amex|americanexpress)\./i,
  /(^|\.)(schwab|fidelity|vanguard|etrade|robinhood|interactivebrokers|revolut|wise|monzo|n26|paypal|stripe)\./i,
  /(^|\.)(icbc|ccb|abchina|boc|bankcomm|bocom|cmbchina|spdb|psbc|pingan|alipay|antgroup)\./i,
  /(^|\.)(binance|coinbase|kraken|okx|bybit|bitfinex|metamask|ledger|trezor)\./i,
  // Anchored to their exact domain: the bare words collide with unrelated hosts
  // (gemini.google.com is not an exchange, discover.<corp>.com is not a card issuer).
  /(^|\.)(gemini|blockchain|discover)\.(com|info)$/i,
]);

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_NODES = 4000;
const SCAN_LIMIT = Symbol('scan-limit');

// Percent-encoding is a trivial bypass (/%63heckout), so every candidate is
// tested raw and decoded, up to two rounds. Malformed escapes throw, so each
// round is guarded.
function decodeVariants(s: string): string[] {
  const out = [s];
  let cur = s;
  for (let i = 0; i < 2; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      break;
    }
    if (next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
}

// Authority of an absolute URL minus userinfo and port; '' for relative strings.
function hostOf(s: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(s);
  if (!m || !m[1]) return '';
  return m[1]
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '')
    .toLowerCase();
}

export function isBlockedUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url === '') return false;
  for (const variant of decodeVariants(url)) {
    if (BLOCKED_URL_PATTERNS.some((re) => re.test(variant))) return true;
    const host = hostOf(variant);
    if (host && BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) return true;
  }
  return false;
}

// Depth-first walk of every string reachable from `root`. Returns the dotted
// path of the first blocklisted string, SCAN_LIMIT if the caps were hit first,
// or null when the payload is clean. Hitting a cap fails CLOSED.
function firstBlockedPath(root: unknown): string | typeof SCAN_LIMIT | null {
  const stack: { node: unknown; path: string; depth: number }[] = [
    { node: root, path: 'params', depth: 0 },
  ];
  let nodes = 0;
  while (stack.length) {
    const { node, path, depth } = stack.pop()!;
    if (++nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) return SCAN_LIMIT;
    if (typeof node === 'string') {
      if (isBlockedUrl(node)) return path;
      continue;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) =>
        stack.push({ node: child, path: `${path}[${i}]`, depth: depth + 1 }),
      );
      continue;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node as Record<string, unknown>)) {
        stack.push({
          node: (node as Record<string, unknown>)[key],
          path: `${path}.${key}`,
          depth: depth + 1,
        });
      }
    }
  }
  return null;
}

/** null when allowed, otherwise a human-readable refusal. Screens URLs, not behaviour. */
export function screen({
  method,
  params,
  tabUrl,
}: {
  method: string;
  params?: unknown;
  tabUrl?: string | null;
}): string | null {
  if (isBlockedUrl(tabUrl)) {
    return 'refused: task tab is on a blocklisted page (payment / account-security class); ask the owner to handle it';
  }
  if (params && typeof params === 'object') {
    const hit = firstBlockedPath(params);
    if (hit === SCAN_LIMIT)
      return `refused: ${method} params are too large or too deeply nested to screen safely`;
    if (hit) return `refused: ${method} ${hit} targets a blocklisted URL`;
  }
  return null;
}

export { BLOCKED_URL_PATTERNS, BLOCKED_HOST_PATTERNS };
