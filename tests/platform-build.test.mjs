import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('platform build is separate and loopback-only', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../.output-platform/chrome-mv3/manifest.json', import.meta.url)),
  );
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.deepEqual(manifest.externally_connectable.matches, ['http://localhost/*']);
  assert.ok(manifest.permissions.includes('debugger'));
  assert.equal(manifest.background.service_worker, 'background.js');
});

test('platform artifacts contain web confirmation and no Popup confirmation command', () => {
  const output = new URL('../.output-platform/chrome-mv3/', import.meta.url);
  const scripts = fs
    .readdirSync(output, { recursive: true })
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(new URL(name, output), 'utf8'))
    .join('\n');
  assert.ok(scripts.includes('browser-user-login-confirm'));
  assert.ok(!scripts.includes('browser-binding-confirm'));
  assert.ok(!scripts.includes('platform-confirm'));
});
