// Coarse platform hints (OS, CPU architecture, browser + major version) that
// help the owner and the Agent tell several connected browsers apart, e.g.
// "macOS · arm64 · Chrome 142". Read only from APIs that need no manifest
// permission: chrome.runtime.getPlatformInfo() and navigator.userAgentData /
// navigator.userAgent. No machine name, profile name or account is included.

export interface PlatformHint {
  os?: string;
  arch?: string;
  browser?: string;
  /** Major version only. */
  browserVersion?: string;
}

/** Subset of chrome.runtime.PlatformInfo; values are Chrome's enum strings. */
export interface PlatformInfoLike {
  os?: string;
  arch?: string;
}

interface UserAgentDataLike {
  brands?: { brand?: string; version?: string }[];
}
interface NavigatorLike {
  userAgent?: string;
  userAgentData?: UserAgentDataLike;
}

const OS_NAMES: Record<string, string> = {
  mac: 'macOS',
  win: 'Windows',
  linux: 'Linux',
  cros: 'ChromeOS',
  android: 'Android',
  openbsd: 'OpenBSD',
  fuchsia: 'Fuchsia',
};
// chrome.runtime.PlatformArch values, reported as-is.
const ARCHES = new Set(['arm', 'arm64', 'x86-32', 'x86-64', 'mips', 'mips64', 'riscv64']);
// userAgentData brand → display name, most specific first.
const BRANDS: [string, string][] = [
  ['Microsoft Edge', 'Edge'],
  ['Opera', 'Opera'],
  ['Brave', 'Brave'],
  ['Google Chrome', 'Chrome'],
];

function osFromUserAgent(ua: string): string | undefined {
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return undefined;
}

function browserFromUserAgent(ua: string): string | undefined {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Chrome\/|Chromium\//.test(ua)) return 'Chrome';
  return undefined;
}

function major(version: string | undefined): string | undefined {
  const m = /^(\d{1,4})(?:\.|$)/.exec(version ?? '');
  return m?.[1];
}

/** Build the hint from getPlatformInfo() (when available) and the navigator. */
export function platformHint(
  info?: PlatformInfoLike,
  nav: NavigatorLike | undefined = globalThis.navigator,
): PlatformHint {
  const ua = nav?.userAgent ?? '';
  const brands = nav?.userAgentData?.brands ?? [];
  const known = BRANDS.find(([brand]) => brands.some((b) => b.brand === brand));
  const browser = known?.[1] ?? browserFromUserAgent(ua);
  const version =
    major(known && brands.find((b) => b.brand === known[0])?.version) ??
    major(brands.find((b) => b.brand === 'Chromium')?.version) ??
    major(/(?:Chrome|Chromium)\/([\d.]+)/.exec(ua)?.[1]);
  const os = (info?.os && OS_NAMES[info.os]) || osFromUserAgent(ua);
  const arch = info?.arch && ARCHES.has(info.arch) ? info.arch : undefined;
  return {
    ...(os ? { os } : {}),
    ...(arch ? { arch } : {}),
    ...(browser ? { browser } : {}),
    ...(browser && version ? { browserVersion: version } : {}),
  };
}

/** "macOS · arm64 · Chrome 142"; empty when nothing is known. */
export function platformLabel(hint: PlatformHint | undefined): string {
  if (!hint) return '';
  const browser = hint.browser
    ? hint.browserVersion
      ? `${hint.browser} ${hint.browserVersion}`
      : hint.browser
    : '';
  return [hint.os, hint.arch, browser].filter(Boolean).join(' · ');
}

/** Read the hint; falls back to the navigator alone if getPlatformInfo is unavailable. */
export async function readPlatformHint(
  getPlatformInfo: (() => Promise<PlatformInfoLike>) | undefined = typeof globalThis.chrome?.runtime
    ?.getPlatformInfo === 'function'
    ? () => chrome.runtime.getPlatformInfo()
    : undefined,
): Promise<PlatformHint> {
  let info: PlatformInfoLike | undefined;
  try {
    info = await getPlatformInfo?.();
  } catch {
    info = undefined;
  }
  return platformHint(info);
}
