import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.output/chrome-mv3');
test('WXT emits the remote extension with its required permissions and entrypoints', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.name, /Coco/);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
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
  for (const file of ['popup.html', 'sidepanel.html', manifest.background.service_worker])
    assert.ok(fs.existsSync(path.join(output, file)), file);
  assert.equal(fs.existsSync(path.join(output, 'panel.html')), false);
  assert.equal(fs.existsSync(path.join(root, 'extension')), false);
  for (const file of ['popup.html', 'sidepanel.html']) {
    const html = fs.readFileSync(path.join(output, file), 'utf8');
    assert.match(html, /id="root"/);
    for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
      assert.ok(fs.existsSync(path.join(output, asset.replace(/^\//, ''))), asset);
    }
  }
});
