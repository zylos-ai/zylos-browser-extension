import { defineBackground } from 'wxt/utils/define-background';
import { startRemoteBackground } from './remote';

export default defineBackground({
  type: 'module',
  // Imports stay pure; Chrome listeners are registered only when the worker runs.
  main() {
    startRemoteBackground();
  },
});
