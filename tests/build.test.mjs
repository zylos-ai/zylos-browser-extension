import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.output/chrome-mv3');
test('build exposes one sidebar and no toolbar popup', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.name, 'Coco · Agent Browser (Zylos)');
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual([...manifest.permissions].sort(), [
    'alarms',
    'debugger',
    'sidePanel',
    'storage',
    'tabGroups',
    'tabs',
  ]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.ok(!manifest.web_accessible_resources?.length);
  const pages = fs.readdirSync(output).filter((file) => file.endsWith('.html'));
  assert.deepEqual(pages, ['sidepanel.html']);
  assert.ok(fs.existsSync(path.join(output, 'background.js')));
  const html = fs.readFileSync(path.join(output, 'sidepanel.html'), 'utf8');
  assert.match(html, /id="root"/);
  for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
    assert.ok(fs.existsSync(path.join(output, asset.replace(/^\//, ''))), asset);
  }
});
test('bundle contains Remote commands and no former protocol entrypoints', () => {
  const scripts = fs
    .readdirSync(output, { recursive: true })
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(output, name), 'utf8'))
    .join('\n');
  for (const message of ['zylos-browser-remote.v2', 'remote-chat-send', 'remote-save'])
    assert.ok(scripts.includes(message), message);
  for (const message of [
    'platform-login',
    'browser-binding-confirm',
    'cdp-command',
    'cdp-bind',
    'cdp-event',
  ])
    assert.ok(!scripts.includes(message), message);
});
