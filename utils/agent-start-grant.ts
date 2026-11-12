import { z } from 'zod';
import { siteDurationSchema } from './site-access';

/**
 * Owner consent for Agent-started tasks. The grant is bound to the connection
 * identity (relay URL and keyId, the same binding as site rules) so a
 * recycled MV3 worker can restore it without storing the access key.
 */
export const AGENT_START_GRANT_KEY = 'agentStartGrant';
// Same choices and request encoding as site rules: 1/7/30 days in minutes, null = until turned off.
export const AGENT_START_DURATION_DAYS = [1, 7, 30] as const;
export const AGENT_START_DEFAULT_MINUTES = 7 * 24 * 60;
export const agentStartDurationSchema = siteDurationSchema;
const MAX_GRANT_MS = 30 * 24 * 60 * 60_000;
// Chrome clamps longer setTimeout delays; long grants re-arm instead of firing early.
export const MAX_TIMER_MS = 2_147_483_647;
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const agentStartGrantSchema = z
  .object({
    binding: z.string().min(1).max(512),
    grantedAt: timestamp,
    expiresAt: timestamp.nullable(),
  })
  .strict()
  .refine(
    (grant) =>
      grant.expiresAt === null ||
      (grant.expiresAt > grant.grantedAt && grant.expiresAt - grant.grantedAt <= MAX_GRANT_MS),
    'Invalid agent-start lifetime',
  );
export type AgentStartGrant = z.infer<typeof agentStartGrantSchema>;

export function agentStartBinding(relayUrl: string, keyId: string) {
  return relayUrl && keyId ? `${relayUrl}|${keyId}` : '';
}

export function createAgentStartGrant(
  binding: string,
  durationMinutes: number | null | undefined,
  now = Date.now(),
): AgentStartGrant {
  const minutes =
    durationMinutes === undefined
      ? AGENT_START_DEFAULT_MINUTES
      : agentStartDurationSchema.parse(durationMinutes);
  return agentStartGrantSchema.parse({
    binding,
    grantedAt: now,
    expiresAt: minutes === null ? null : now + minutes * 60_000,
  });
}

/**
 * A grant created "in the future" means the clock moved backwards; like
 * interactive site rules, such a permissive grant is not honoured.
 */
export function agentStartGrantLive(grant: AgentStartGrant | undefined, now = Date.now()) {
  return !!grant && grant.grantedAt <= now && (grant.expiresAt === null || grant.expiresAt > now);
}

/** Returns the stored grant only when valid, unexpired and bound to `binding`. */
export function restorableAgentStartGrant(
  stored: unknown,
  binding: string,
  now = Date.now(),
): AgentStartGrant | undefined {
  if (!binding) return;
  const parsed = agentStartGrantSchema.safeParse(stored);
  if (!parsed.success || parsed.data.binding !== binding) return;
  return agentStartGrantLive(parsed.data, now) ? parsed.data : undefined;
}

export async function loadAgentStartGrant(binding: string, now = Date.now()) {
  const stored = (await chrome.storage.local.get([AGENT_START_GRANT_KEY]))[AGENT_START_GRANT_KEY];
  const grant = restorableAgentStartGrant(stored, binding, now);
  // Expired, damaged or differently bound records are removed, never reused.
  if (!grant && stored !== undefined) await clearAgentStartGrant();
  return grant;
}

export function saveAgentStartGrant(grant: AgentStartGrant): Promise<void> {
  return chrome.storage.local.set({ [AGENT_START_GRANT_KEY]: grant });
}

export function clearAgentStartGrant(): Promise<void> {
  return chrome.storage.local.remove(AGENT_START_GRANT_KEY);
}
