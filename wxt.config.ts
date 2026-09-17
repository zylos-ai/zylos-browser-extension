import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Zylos Browser',
    description: '__MSG_extensionDescription__',
    default_locale: 'en',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    minimum_chrome_version: '125',
    permissions: [
      'debugger',
      'storage',
      'tabs',
      'alarms',
      'sidePanel',
      'tabGroups',
      'webNavigation',
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
  },
});
