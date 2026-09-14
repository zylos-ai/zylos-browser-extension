import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('default build connects only through the remote extension entrypoints', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../.output/chrome-mv3/manifest.json', import.meta.url)),
  );
  assert.equal(manifest.name, 'Coco · Agent Browser (Zylos)');
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.ok(manifest.permissions.includes('debugger'));
  assert.equal(manifest.background.service_worker, 'background.js');
});

test('default artifacts contain relay chat and commands without platform login', () => {
  const output = new URL('../.output/chrome-mv3/', import.meta.url);
  const scripts = fs
    .readdirSync(output, { recursive: true })
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(new URL(name, output), 'utf8'))
    .join('\n');
  assert.ok(scripts.includes('zylos-browser-remote.v2'));
  assert.ok(scripts.includes('remote-chat-send'));
  assert.ok(scripts.includes('remote-save'));
  assert.ok(!scripts.includes('browser-user-login-confirm'));
  assert.ok(!scripts.includes('platform-login'));
  assert.ok(!scripts.includes('browser-binding-confirm'));
  assert.ok(!scripts.includes('platform-confirm'));
});
