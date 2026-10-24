import { z } from 'zod';

declare const __DETAIL_BUILD__: string;

const buildSchema = z.object({
  id: z.string().uuid(),
  commit: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .optional(),
  dirty: z.boolean().optional(),
  builtAt: z.string().datetime({ precision: 3 }).optional(),
});

export function extensionVersion(): string {
  try {
    const version = chrome.runtime.getManifest().version;
    return /^\d+(?:\.\d+){0,3}$/.test(version) ? version : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export function extensionBuild(
  raw: unknown = typeof __DETAIL_BUILD__ === 'undefined' ? undefined : __DETAIL_BUILD__,
) {
  if (typeof raw !== 'string' || raw.length > 1024) return undefined;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    // Select validated metadata only; source archives have no known commit.
    const result: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(buildSchema.shape)) {
      const parsed = schema.safeParse(value[key]);
      if (parsed.success && parsed.data !== undefined) result[key] = parsed.data;
    }
    return Object.keys(result).length ? buildSchema.parse(result) : undefined;
  } catch {
    return undefined;
  }
}
