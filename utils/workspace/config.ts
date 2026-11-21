// OpenMax Workspace endpoint configuration. The allowed Workspace origins are
// baked in at build time (see wxt.config.ts): release builds carry exactly one
// (WXT_WORKSPACE_URL); test builds may carry several named environments
// (WXT_WORKSPACE_ENVS) that the owner picks from. There is no free-text address.

export const WORKSPACE_CLIENT_ID = 'openmax-browser';
export const WORKSPACE_SCOPE = 'connect:browser';
export const WORKSPACE_URL_KEY = 'workspaceUrl';
export const WORKSPACE_AUTH_KEY = 'workspaceAuth';
export const WORKSPACE_CONNECTION_KEY = 'workspaceConnection';

export interface WorkspaceEnv {
  name: string;
  url: string;
}

declare const __WORKSPACE_ENVS__: string;

/** Build-time Workspace environments; the first one is the build default. */
export function workspaceEnvs(
  raw: unknown = typeof __WORKSPACE_ENVS__ === 'undefined' ? undefined : __WORKSPACE_ENVS__,
): WorkspaceEnv[] {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const envs: WorkspaceEnv[] = [];
  for (const item of parsed) {
    const name = typeof item?.name === 'string' ? item.name : '';
    const url = typeof item?.url === 'string' ? normalizeWorkspaceUrl(item.url) : null;
    if (url && !envs.some((env) => env.url === url)) envs.push({ name, url });
  }
  return envs;
}

export function buildWorkspaceUrl(envs = workspaceEnvs()): string {
  return envs[0]?.url ?? '';
}

/**
 * The Workspace origin to use: the stored choice only when this build allows
 * it, otherwise the build default (a release build never talks to a leftover
 * test or custom address from an older build).
 */
export function resolveWorkspaceUrl(stored: unknown, envs = workspaceEnvs()): string {
  const url = typeof stored === 'string' ? normalizeWorkspaceUrl(stored) : null;
  return url && envs.some((env) => env.url === url) ? url : buildWorkspaceUrl(envs);
}

/** Origin-only https URL (http allowed for localhost development). */
export function normalizeWorkspaceUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Short default browser name like "Chrome · Mac". */
export function defaultBrowserName(userAgent = globalThis.navigator?.userAgent ?? ''): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Brave/.test(userAgent)
        ? 'Brave'
        : 'Chrome';
  const os = /Mac OS X|Macintosh/.test(userAgent)
    ? 'Mac'
    : /Windows/.test(userAgent)
      ? 'Windows'
      : /CrOS/.test(userAgent)
        ? 'ChromeOS'
        : /Android/.test(userAgent)
          ? 'Android'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';
  return os ? `${browser} · ${os}` : browser;
}
