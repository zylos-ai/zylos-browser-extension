import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  manifest: {
    name: 'Coco · Agent Browser',
    description:
      'Give your Zylos Agent dedicated, marked work tabs while you keep browsing. Stop at any time.',
    minimum_chrome_version: '125',
    permissions: ['debugger', 'storage', 'tabs', 'alarms', 'sidePanel', 'tabGroups'],
    action: { default_title: 'Coco Agent Browser' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  },
});
