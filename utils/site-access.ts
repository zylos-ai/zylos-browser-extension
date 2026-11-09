import { z } from 'zod';
import { isBlockedUrl } from './guard';

export const SITE_ACCESS_KEY = 'siteAccess';
const MAX_GRANTS = 100;
const MAX_EVENTS = 200;
const AUDIT_TTL = 7 * 24 * 60 * 60_000;
const MAX_GRANT_MS = 24 * 60 * 60_000;
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

function originOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hostname.includes('*') ||
      url.origin === 'null'
    )
      return;
    return url.origin;
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
    origin: originSchema,
    mode: z.enum(['read-only', 'interactive']),
    createdAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .refine(
    (grant) =>
      grant.expiresAt > grant.createdAt && grant.expiresAt - grant.createdAt <= MAX_GRANT_MS,
    'Invalid authorization lifetime',
  );
export const siteAccessEventSchema = z
  .object({
    id: z.string().uuid(),
    at: timestamp,
    origin: originSchema,
    action: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    mode: z.enum(['read-only', 'interactive']).optional(),
    allowed: z.boolean(),
    grantId: z.string().uuid().optional(),
  })
  .strict();
export const siteAccessStateSchema = z
  .object({
    grants: z.array(siteGrantSchema).max(MAX_GRANTS),
    audit: z.array(siteAccessEventSchema).max(MAX_EVENTS),
  })
  .strict();
export type SiteGrant = z.infer<typeof siteGrantSchema>;
export type SiteAccessEvent = z.infer<typeof siteAccessEventSchema>;
const savedSchema = siteAccessStateSchema.extend({ binding: z.string().min(1).max(512) }).strict();

let grants: SiteGrant[] = [];
let audit: SiteAccessEvent[] = [];
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
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function pruneAudit(events = audit) {
  const now = Date.now();
  return events.filter((event) => event.at <= now && event.at > now - AUDIT_TTL).slice(-MAX_EVENTS);
}
function liveGrant(url: unknown) {
  if (!initialized) return;
  const origin = originOf(url);
  const now = Date.now();
  return grants.find(
    (grant) => grant.origin === origin && grant.createdAt <= now && grant.expiresAt > now,
  );
}
async function persist(nextGrants: SiteGrant[], nextAudit: SiteAccessEvent[]) {
  await chrome.storage.local.set({
    [SITE_ACCESS_KEY]: {
      binding,
      grants: nextGrants,
      audit: nextAudit,
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
  };
}

export function initializeSiteAccess(recipient: string): Promise<void> {
  const epoch = ++generation;
  revision++;
  initialized = false;
  grants = [];
  audit = [];
  binding = recipient;
  return serial(async () => {
    if (!recipient || recipient.length > 512) fail('SITE_ACCESS_BINDING_REQUIRED');
    const stored = await chrome.storage.local.get([SITE_ACCESS_KEY]);
    if (epoch !== generation) return;
    const parsed = savedSchema.safeParse(stored[SITE_ACCESS_KEY]);
    if (
      parsed.success &&
      parsed.data.binding === recipient &&
      parsed.data.grants.every((grant) => grant.createdAt <= Date.now()) &&
      new Set(parsed.data.grants.map((grant) => grant.origin)).size === parsed.data.grants.length
    ) {
      grants = parsed.data.grants;
      audit = pruneAudit(parsed.data.audit);
    }
    initialized = true;
  });
}

export function grantSiteAccess(
  origin: string,
  mode: SiteGrant['mode'],
  durationMinutes: number,
): Promise<void> {
  const epoch = generation;
  return serial(async () => {
    if (!initialized || !binding || epoch !== generation) fail('SITE_ACCESS_NOT_READY');
    originSchema.parse(origin);
    z.number().int().min(5).max(1440).parse(durationMinutes);
    const now = Date.now();
    const grant = siteGrantSchema.parse({
      id: crypto.randomUUID(),
      origin,
      mode,
      createdAt: now,
      expiresAt: now + durationMinutes * 60_000,
    });
    const next = [
      ...grants.filter((value) => value.origin !== origin && value.expiresAt > now),
      grant,
    ];
    if (next.length > MAX_GRANTS) fail('SITE_ACCESS_LIMIT');
    const events = pruneAudit([
      ...audit,
      {
        id: crypto.randomUUID(),
        at: now,
        origin,
        action: 'grant',
        allowed: true,
        mode,
        grantId: grant.id,
      },
    ]);
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
  if (revoked)
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
  return serial(async () => {
    if (binding) await persist([], []);
  });
}

export function isSiteUrlBlocked(url: unknown): boolean {
  return isBlockedUrl(url) && !liveGrant(url);
}

export function assertSiteAction(url: unknown, action: string): void {
  const grant = liveGrant(url);
  if (!grant && isBlockedUrl(url)) fail('BLOCKED_URL');
  if (grant?.mode === 'read-only' && !READ_ACTIONS.has(action)) fail('SITE_READ_ONLY');
}

export function recordSiteAccess(url: string, action: string, allowed: boolean): Promise<void> {
  const origin = originOf(url);
  const grant = liveGrant(url);
  if (!initialized || !origin || (!isBlockedUrl(url) && !grant)) return Promise.resolve();
  const event = siteAccessEventSchema.parse({
    id: crypto.randomUUID(),
    at: Date.now(),
    origin,
    action,
    allowed,
    ...(grant ? { mode: grant.mode, grantId: grant.id } : {}),
  });
  const epoch = generation;
  return serial(async () => {
    if (!initialized || epoch !== generation) return;
    audit = pruneAudit([...audit, event]);
    await persist(grants, audit);
  });
}
