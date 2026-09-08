// @vitest-environment node
import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('uses WXT default source and output structure without legacy wrappers', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(pkg.scripts.build).toBe('wxt build');
  expect(pkg.scripts.zip).toBe('wxt zip');
  expect(pkg.scripts['build:extension']).toBeUndefined();
  expect(pkg.scripts['install:local']).toBeUndefined();
  expect(pkg.dependencies.ws).toBeUndefined();
  expect(fs.readFileSync(path.join(root, 'wxt.config.ts'), 'utf8')).not.toMatch(
    /srcDir:|outDir:|entrypointsDir:/,
  );
  for (const item of [
    'entrypoints/background/index.ts',
    'entrypoints/popup/index.html',
    'entrypoints/sidepanel/index.html',
    'hooks/useAgent.ts',
    'components/App.tsx',
    'assets/styles.css',
    'utils/automation/executor.ts',
  ]) {
    expect(fs.existsSync(path.join(root, item)), item).toBe(true);
  }
  for (const item of [
    'browser',
    'extension',
    'artifacts',
    'scripts',
    'protocol',
    'test',
    'entrypoints/panel',
    'SKILL.md',
    'ecosystem.config.cjs',
    'src/server.ts',
    'dist/server.js',
  ]) {
    expect(fs.existsSync(path.join(root, item)), item).toBe(false);
  }
});
test('production sources never import the channel or former browser source tree', () => {
  function walk(dir: string) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (/\.(ts|tsx|js)$/.test(file)) {
        expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(
          /src\/protocol|zylos-browser-channel|from ['"]node:|from ['"][^'"]*browser\//,
        );
      }
    }
  }
  for (const dir of ['entrypoints', 'components', 'hooks', 'utils']) walk(path.join(root, dir));
});
