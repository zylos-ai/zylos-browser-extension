// OpenMax Workspace endpoint configuration. The base URL comes from the build
// (WXT_WORKSPACE_URL; development builds default to the INT Workspace) and can
// be overridden in settings. No production URL is hard-coded in this repo yet.

export const WORKSPACE_CLIENT_ID = 'openmax-browser';
export const WORKSPACE_SCOPE = 'connect:browser';
export const WORKSPACE_INT_URL = 'https://cws-int.coco.xyz';
export const WORKSPACE_URL_KEY = 'workspaceUrl';
export const WORKSPACE_AUTH_KEY = 'workspaceAuth';
export const WORKSPACE_CONNECTION_KEY = 'workspaceConnection';

export function buildWorkspaceUrl(): string {
  const env = (import.meta as { env?: Record<string, unknown> }).env ?? {};
  const configured = typeof env.WXT_WORKSPACE_URL === 'string' ? env.WXT_WORKSPACE_URL : '';
  return normalizeWorkspaceUrl(configured || (env.DEV ? WORKSPACE_INT_URL : '')) ?? '';
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
