// Compatibility helpers for inspecting initial settings. Product callers use
// site-access.ts, which evaluates the owner's configured defaults and custom rules.
import { defaultSiteRules, matchingDefaultRule } from './site-rules';
const defaults = defaultSiteRules();
const BLOCKED_URL_PATTERNS = Object.freeze(
  defaults.filter((rule) => rule.kind === 'url-regex').map((rule) => new RegExp(rule.pattern, 'i')),
);
const BLOCKED_HOST_PATTERNS = Object.freeze(
  defaults
    .filter((rule) => rule.kind === 'host-regex')
    .map((rule) => new RegExp(rule.pattern, 'i')),
);

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_NODES = 4000;
const SCAN_LIMIT = Symbol('scan-limit');

export function isBlockedUrl(url: unknown): boolean {
  return matchingDefaultRule(url, defaults)?.mode === 'denied';
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
