import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  manifest: {
    name: 'Coco · Agent Browser (Zylos)',
    description:
      'Chat with your Zylos Agent and let it work in dedicated, marked tabs of this browser. Stop at any time.',
    minimum_chrome_version: '125',
    permissions: ['debugger', 'storage', 'tabs', 'alarms', 'sidePanel', 'tabGroups'],
    action: { default_title: 'Coco Agent Browser' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
    // The relay connection uses WebSocket; no website-to-extension entrypoint is needed.
  },
});
