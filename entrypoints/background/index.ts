import { defineBackground } from 'wxt/utils/define-background';
import { startBackground } from './runtime';

export default defineBackground({
  type: 'module',
  // Imports stay pure; Chrome listeners are registered only when the worker runs.
  main() {
    startBackground();
  },
});
