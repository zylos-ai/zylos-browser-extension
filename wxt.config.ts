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
// OpenMax Workspace API origin (sign-in + browser connections). Set
// WXT_WORKSPACE_URL for release builds; development builds default to INT.
function workspaceOrigin(mode: string): string {
  const value =
    process.env.WXT_WORKSPACE_URL || (mode === 'development' ? 'https://cws-int.coco.xyz' : '');
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost')
    throw new Error('WXT_WORKSPACE_URL must be https');
  return url.origin;
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
  vite: () => ({
    define: { __DETAIL_BUILD__: JSON.stringify(detailBuild) },
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
      ...(workspaceOrigin(mode) ? [`${workspaceOrigin(mode)}/*`] : []),
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
