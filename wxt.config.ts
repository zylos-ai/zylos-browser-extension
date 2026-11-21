import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

let commit = 'unavailable';
let dirty = true;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .some((line) => !!line && line !== '?? node_modules');
} catch {
  /* Non-Git source archives still receive a unique build identity. */
}
// OpenMax Workspace origins, baked in at build time (no free-text address):
// - Release: WXT_WORKSPACE_URL=https://… — exactly one origin, no picker. No
//   production origin is defined in this repo, so a production build without
//   it fails instead of guessing.
// - Test: WXT_WORKSPACE_ENVS='INT=https://cws-int.coco.xyz,dev=https://…' —
//   named environments; the first (or the one matching WXT_WORKSPACE_URL) is
//   the default and the sidebar shows an environment picker when >1.
// - Development (`wxt` dev mode) with neither set defaults to INT.
const WORKSPACE_INT_URL = 'https://cws-int.coco.xyz';
const releaseCommand = ['build', 'zip'].includes(process.argv[2] ?? '');

function workspaceOrigin(value: string, source: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${source}: invalid Workspace URL "${value}"`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost')
    throw new Error(`${source}: Workspace URL must be https ("${value}")`);
  return url.origin;
}

function workspaceEnvs(
  mode: string,
  env: Record<string, string | undefined> = process.env,
): { name: string; url: string }[] {
  const single = env.WXT_WORKSPACE_URL?.trim()
    ? workspaceOrigin(env.WXT_WORKSPACE_URL, 'WXT_WORKSPACE_URL')
    : '';
  const envs: { name: string; url: string }[] = [];
  for (const entry of (env.WXT_WORKSPACE_ENVS ?? '').split(',')) {
    if (!entry.trim()) continue;
    const at = entry.indexOf('=');
    const name = at > 0 ? entry.slice(0, at).trim() : '';
    if (!name) throw new Error(`WXT_WORKSPACE_ENVS: expected NAME=URL, got "${entry.trim()}"`);
    const url = workspaceOrigin(entry.slice(at + 1), 'WXT_WORKSPACE_ENVS');
    if (!envs.some((e) => e.url === url)) envs.push({ name, url });
  }
  if (envs.length) {
    const preferred = envs.findIndex((e) => e.url === single);
    if (single && preferred < 0) envs.unshift({ name: 'default', url: single });
    else if (preferred > 0) envs.unshift(...envs.splice(preferred, 1));
    return envs;
  }
  if (single) return [{ name: '', url: single }];
  if (mode === 'development') return [{ name: 'INT', url: WORKSPACE_INT_URL }];
  // `wxt prepare` (typecheck, postinstall) resolves the config without bundling.
  if (!releaseCommand) return [];
  throw new Error(
    'WXT_WORKSPACE_URL is required for release builds (no production Workspace origin is ' +
      'defined in this repo). Example: WXT_WORKSPACE_URL=https://<workspace-origin> npm run build. ' +
      "For a test build use WXT_WORKSPACE_ENVS='INT=https://cws-int.coco.xyz,dev=https://…'.",
  );
}

/**
 * ws:// loopback relays are a development/test convenience only: a release build
 * (just WXT_WORKSPACE_URL, no test environments) accepts Workspace relays over wss://.
 */
function workspaceLoopbackRelay(
  mode: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return mode === 'development' || !!env.WXT_WORKSPACE_ENVS?.trim();
}

const detailBuild = JSON.stringify({
  id: randomUUID(),
  commit,
  dirty,
  builtAt: new Date().toISOString(),
});

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  vite: (env) => ({
    define: {
      __DETAIL_BUILD__: JSON.stringify(detailBuild),
      __WORKSPACE_ENVS__: JSON.stringify(JSON.stringify(workspaceEnvs(env.mode))),
      __WORKSPACE_LOOPBACK_RELAY__: JSON.stringify(workspaceLoopbackRelay(env.mode)),
    },
    plugins: [tailwindcss()],
  }),
  manifest: ({ mode }) => ({
    name: 'Zylos Browser',
    description: '__MSG_extensionDescription__',
    default_locale: 'en',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    minimum_chrome_version: '125',
    permissions: [
      'debugger',
      'scripting',
      'storage',
      'tabs',
      'alarms',
      'sidePanel',
      'tabGroups',
      'webNavigation',
      // OpenMax Workspace sign-in via launchWebAuthFlow (chromiumapp.org callback).
      'identity',
    ],
    // The sidebar can stay open while the owner switches sites. activeTab alone
    // does not grant access to each newly selected page. Reads still target only
    // the page bound to an owner message, never all open tabs.
    host_permissions: [
      'http://*/*',
      'https://*/*',
      ...workspaceEnvs(mode).map((env) => `${env.url}/*`),
    ],
    action: {
      default_title: '__MSG_openSidebar__',
      default_icon: {
        16: 'icons/16.png',
        32: 'icons/32.png',
        48: 'icons/48.png',
        128: 'icons/128.png',
      },
    },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
    // The relay connection uses WebSocket; no website-to-extension entrypoint is needed.
  }),
});
