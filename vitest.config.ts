import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx,mjs}'],
    exclude: ['tests/build.test.mjs', 'tests/remote-build.test.mjs'],
    environment: 'jsdom',
    restoreMocks: true,
  },
});
