import { defineBackground } from 'wxt/utils/define-background';
import { startPlatformBackground } from './platform';

export default defineBackground({
  type: 'module',
  // Imports stay pure; Chrome listeners are registered only when the worker runs.
  main() {
    startPlatformBackground();
  },
});
