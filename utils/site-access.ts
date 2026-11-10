import { z } from 'zod';
import {
  defaultRulesSchema,
  defaultSiteRules,
  matchingDefaultRule,
  matchesSitePattern,
  pageUrl,
  siteMatchTypeSchema,
  siteModeSchema,
  validSitePattern,
  type DefaultSiteRule,
  type SiteMatchType,
} from './site-rules';
export { defaultRuleSchema } from './site-rules';

export const SITE_ACCESS_KEY = 'siteAccess';
const MAX_GRANTS = 100;
const MAX_EVENTS = 200;
const AUDIT_TTL = 7 * 24 * 60 * 60_000;
const MAX_GRANT_MS = 30 * 24 * 60 * 60_000;
// Keep minute-based requests compatible with previously bundled panels.
export const siteDurationSchema = z
  .number()
  .int()
  .min(5)
  .max(30 * 24 * 60)
  .nullable();
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

function originOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    return pageUrl(value)?.origin;
  } catch {
    return;
  }
}

const originSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => originOf(value) === value,
    'Use an exact HTTP(S) origin without a path, query, fragment or credentials',
  );
export const siteGrantSchema = z
  .object({
    id: z.string().uuid(),
    origin: z.string().min(1).max(2048),
    matchType: siteMatchTypeSchema.optional(),
    mode: siteModeSchema,
    createdAt: timestamp,
    expiresAt: timestamp.nullable(),
  })
  .strict()
  .refine(
    (grant) =>
      (grant.expiresAt === null ||
        (grant.expiresAt > grant.createdAt && grant.expiresAt - grant.createdAt <= MAX_GRANT_MS)) &&
      validSitePattern(grant.origin, grant.matchType || 'origin'),
    'Invalid authorization lifetime',
  );
export const siteAccessEventSchema = z
  .object({
    id: z.string().uuid(),
    at: timestamp,
    origin: originSchema,
    action: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    mode: siteModeSchema.optional(),
    allowed: z.boolean(),
    grantId: z.string().uuid().optional(),
  })
  .strict();
export const siteAccessStateSchema = z
  .object({
    grants: z.array(siteGrantSchema).max(MAX_GRANTS),
    audit: z.array(siteAccessEventSchema).max(MAX_EVENTS),
    defaults: defaultRulesSchema,
    recoveryRequired: z.boolean().optional(),
  })
  .strict();
export type SiteGrant = z.infer<typeof siteGrantSchema>;
export type SiteAccessEvent = z.infer<typeof siteAccessEventSchema>;
const savedSchema = z.object({
  binding: z.string().min(1).max(512),
  grants: z.unknown(),
  audit: z.unknown(),
  defaults: z.unknown().optional(),
  recoveryRequired: z.unknown().optional(),
});
const savedDefaultSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  mode: siteModeSchema,
});

let grants: SiteGrant[] = [];
let audit: SiteAccessEvent[] = [];
let defaults: DefaultSiteRule[] = defaultSiteRules();
let recoveryRequired = false;
let binding = '';
let initialized = false;
let revision = 0;
let generation = 0;
let queue: Promise<unknown> = Promise.resolve();
const READ_ACTIONS = new Set([
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
]);

function serial<T>(work: () => Promise<T>): Promise<T> {
  const pending = queue.catch(() => {}).then(work);
  queue = pending;
  return pending;
}
function fail(code: string, message = code): never {
  throw Object.assign(new Error(message), { code });
}
function pruneAudit(events = audit) {
  const now = Date.now();
  return events.filter((event) => event.at <= now && event.at > now - AUDIT_TTL).slice(-MAX_EVENTS);
}
function liveGrant(url: unknown) {
  if (!initialized) return;
  const now = Date.now();
  return grants.findLast(
    (grant) =>
      matchesSitePattern(url, grant.origin, grant.matchType || 'origin') &&
      (grant.createdAt <= now || grant.mode !== 'interactive') &&
      (grant.expiresAt === null || grant.expiresAt > now),
  );
}
function decision(url: unknown) {
  if (recoveryRequired) return { mode: 'denied' } as const;
  const grant = liveGrant(url);
  if (grant) return { mode: grant.mode, grant };
  const rule = matchingDefaultRule(url, defaults);
  return { mode: rule?.mode || 'interactive', rule } as const;
}
async function persist(
  nextGrants: SiteGrant[],
  nextAudit: SiteAccessEvent[],
  nextDefaults = defaults,
) {
  await chrome.storage.local.set({
    [SITE_ACCESS_KEY]: {
      binding,
      grants: nextGrants,
      audit: nextAudit,
      defaults: nextDefaults.map(({ id, enabled, mode }) => ({ id, enabled, mode })),
      ...(recoveryRequired ? { recoveryRequired: true } : {}),
    },
  });
}
export function siteAccessRevision() {
  return revision;
}
export function siteAccessState(): z.infer<typeof siteAccessStateSchema> {
  audit = pruneAudit();
  return {
    grants: grants.map((grant) => ({ ...grant })),
    audit: audit.map((event) => ({ ...event })),
    defaults: defaults.map((rule) => ({ ...rule })),
    ...(recoveryRequired ? { recoveryRequired: true } : {}),
  };
}

export function initializeSiteAccess(recipient: string): Promise<void> {
  const epoch = ++generation;
  revision++;
  initialized = false;
  grants = [];
  audit = [];
  defaults = defaultSiteRules();
  recoveryRequired = true;
  binding = recipient;
  return serial(async () => {
    if (!recipient || recipient.length > 512) fail('SITE_ACCESS_BINDING_REQUIRED');
    const stored = await chrome.storage.local.get([SITE_ACCESS_KEY]);
    if (epoch !== generation) return;
    const parsed = savedSchema.safeParse(stored[SITE_ACCESS_KEY]);
    recoveryRequired = stored[SITE_ACCESS_KEY] !== undefined && !parsed.success;
    if (parsed.success && parsed.data.binding === recipient) {
      recoveryRequired =
        parsed.data.recoveryRequired !== undefined && parsed.data.recoveryRequired !== false;
      if (Array.isArray(parsed.data.grants)) {
        if (parsed.data.grants.length > MAX_GRANTS) recoveryRequired = true;
        for (const record of parsed.data.grants) {
          const result = siteGrantSchema.safeParse(record);
          if (!result.success) {
            // Dropping an untrusted restriction could turn a denied site interactive.
            if (!record || typeof record !== 'object' || record.mode !== 'interactive')
              recoveryRequired = true;
            continue;
          }
          const grant = result.data;
          if (grant.mode === 'interactive' && grant.createdAt > Date.now()) continue;
          grants = grants.filter(
            (previous) =>
              previous.origin !== grant.origin ||
              (previous.matchType || 'origin') !== (grant.matchType || 'origin'),
          );
          grants.push(grant);
        }
        grants = grants.slice(-MAX_GRANTS);
      } else recoveryRequired = true;
      if (Array.isArray(parsed.data.audit))
        audit = pruneAudit(
          parsed.data.audit.flatMap((record) => {
            const event = siteAccessEventSchema.safeParse(record);
            return event.success ? [event.data] : [];
          }),
        );
      if (Array.isArray(parsed.data.defaults)) {
        // Legacy full records are also accepted; current labels and patterns come from code.
        for (const record of parsed.data.defaults) {
          const setting = savedDefaultSchema.safeParse(record);
          if (!setting.success) {
            if (record && typeof record === 'object' && typeof record.id === 'string') {
              const seed = defaultSiteRules().find((rule) => rule.id === record.id);
              if (seed) defaults = defaults.map((rule) => (rule.id === seed.id ? seed : rule));
            }
            continue;
          }
          defaults = defaults.map((rule) =>
            rule.id === setting.data.id ? { ...rule, ...setting.data } : rule,
          );
        }
      }
    }
    initialized = true;
  });
}

export function grantSiteAccess(
  origin: string,
  mode: SiteGrant['mode'],
  durationMinutes: number | null,
  matchType: SiteMatchType = 'origin',
): Promise<void> {
  const epoch = generation;
  return serial(async () => {
    if (!initialized || !binding || epoch !== generation) fail('SITE_ACCESS_NOT_READY');
    if (recoveryRequired) fail('SITE_ACCESS_RECOVERY_REQUIRED');
    siteMatchTypeSchema.parse(matchType);
    if (!validSitePattern(origin, matchType)) fail('SITE_PATTERN_INVALID');
    siteDurationSchema.parse(durationMinutes);
    const now = Date.now();
    const grant = siteGrantSchema.parse({
      id: crypto.randomUUID(),
      origin,
      ...(matchType === 'origin' ? {} : { matchType }),
      mode,
      createdAt: now,
      expiresAt: durationMinutes === null ? null : now + durationMinutes * 60_000,
    });
    const next = [
      ...grants.filter(
        (value) =>
          (value.origin !== origin || (value.matchType || 'origin') !== matchType) &&
          (value.expiresAt === null || value.expiresAt > now),
      ),
      grant,
    ];
    if (next.length > MAX_GRANTS) fail('SITE_ACCESS_LIMIT');
    const events = originOf(origin)
      ? pruneAudit([
          ...audit,
          {
            id: crypto.randomUUID(),
            at: now,
            origin,
            action: 'grant',
            allowed: mode !== 'denied',
            mode,
            grantId: grant.id,
          },
        ])
      : pruneAudit();
    await persist(next, events);
    if (epoch !== generation) {
      // A revoke during the storage write wins over the pending grant.
      await persist(grants, pruneAudit());
      fail('SITE_ACCESS_CHANGED');
    }
    grants = next;
    audit = events;
    revision++;
  });
}

export function revokeSiteAccess(id: string): Promise<void> {
  z.string().uuid().parse(id);
  const revoked = grants.find((grant) => grant.id === id);
  revision++;
  generation++;
  grants = grants.filter((grant) => grant.id !== id);
  if (revoked && originOf(revoked.origin))
    audit = pruneAudit([
      ...audit,
      {
        id: crypto.randomUUID(),
        at: Date.now(),
        origin: revoked.origin,
        action: 'revoke',
        allowed: false,
        mode: revoked.mode,
        grantId: id,
      },
    ]);
  return serial(async () => {
    if (binding) await persist(grants, pruneAudit());
  });
}

export function clearSiteAccess(): Promise<void> {
  revision++;
  generation++;
  grants = [];
  audit = [];
  defaults = defaultSiteRules();
  recoveryRequired = false;
  return serial(async () => {
    if (binding) await persist([], []);
  });
}

export function isSiteUrlBlocked(url: unknown): boolean {
  return decision(url).mode === 'denied';
}

export function assertSiteAction(url: unknown, action: string): void {
  if (recoveryRequired)
    fail('BLOCKED_URL', 'BLOCKED_URL: access rules need owner reset in the extension panel');
  const result = decision(url);
  const code =
    result.mode === 'denied'
      ? 'BLOCKED_URL'
      : result.mode === 'read-only' && !READ_ACTIONS.has(action)
        ? 'SITE_READ_ONLY'
        : undefined;
  if (code) {
    const origin = originOf(url);
    fail(code, origin ? `${code}: restricted origin ${origin}` : code);
  }
}

export function recordSiteAccess(url: string, action: string, allowed: boolean): Promise<void> {
  const origin = originOf(url);
  const result = decision(url);
  const grant = result.grant;
  if (!initialized || !origin || (!result.rule && !grant)) return Promise.resolve();
  const event = siteAccessEventSchema.parse({
    id: crypto.randomUUID(),
    at: Date.now(),
    origin,
    action,
    allowed,
    mode: result.mode,
    ...(grant ? { grantId: grant.id } : {}),
  });
  const epoch = generation;
  return serial(async () => {
    if (!initialized || epoch !== generation) return;
    audit = pruneAudit([...audit, event]);
    await persist(grants, audit);
  });
}

/** Default bans are editable settings and use the same evaluator as custom rules. */
export function updateDefaultSiteRule(
  id: string,
  enabled: boolean,
  mode: SiteGrant['mode'],
): Promise<void> {
  siteModeSchema.parse(mode);
  z.boolean().parse(enabled);
  if (recoveryRequired)
    return Promise.reject(
      Object.assign(new Error('SITE_ACCESS_RECOVERY_REQUIRED'), {
        code: 'SITE_ACCESS_RECOVERY_REQUIRED',
      }),
    );
  if (!initialized || !binding)
    return Promise.reject(
      Object.assign(new Error('SITE_ACCESS_NOT_READY'), { code: 'SITE_ACCESS_NOT_READY' }),
    );
  if (!defaults.some((rule) => rule.id === id))
    return Promise.reject(
      Object.assign(new Error('SITE_RULE_NOT_FOUND'), { code: 'SITE_RULE_NOT_FOUND' }),
    );
  revision++;
  generation++;
  const epoch = generation;
  // Restrictive changes are immediate; broadening takes effect only after save.
  const next = defaults.map((rule) => (rule.id === id ? { ...rule, enabled, mode } : rule));
  const previous = defaults.find((rule) => rule.id === id)!;
  const rank = { interactive: 0, 'read-only': 1, denied: 2 };
  if (enabled && (!previous.enabled || rank[mode] > rank[previous.mode])) defaults = next;
  return serial(async () => {
    await persist(grants, pruneAudit(), next);
    if (epoch !== generation) {
      await persist(grants, pruneAudit());
      fail('SITE_ACCESS_CHANGED');
    }
    defaults = next;
  });
}
