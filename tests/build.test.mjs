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
  assert.equal(manifest.name, 'Zylos Browser');
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
    'webNavigation',
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
  for (const message of [
    'zylos-browser-remote.v2',
    'remote-chat-send',
    'remote-save',
    'agent-loop-v1',
    'browser-decision-v1',
  ])
    assert.ok(scripts.includes(message), message);
  for (const message of [
    'chat-ack-v1',
    'STEP_INCOMPLETE',
    'tool-catalog-v1',
    'platform-login',
    'browser-binding-confirm',
    'cdp-command',
    'cdp-bind',
    'cdp-event',
  ])
    assert.ok(!scripts.includes(message), message);
});

test('ships octopus icons at the declared sizes and browser-localized metadata', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  for (const size of [16, 32, 48, 128]) {
    assert.equal(manifest.action.default_icon[size], manifest.icons[size]);
    const png = fs.readFileSync(path.join(output, manifest.icons[size]));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  assert.equal(manifest.default_locale, 'en');
  for (const locale of ['en', 'zh_CN']) {
    const messages = JSON.parse(
      fs.readFileSync(path.join(output, '_locales', locale, 'messages.json'), 'utf8'),
    );
    for (const value of [manifest.description, manifest.action.default_title]) {
      const key = /^__MSG_(.+)__$/.exec(value)?.[1];
      assert.ok(messages[key]?.message, `${locale}: ${value}`);
    }
  }
});
