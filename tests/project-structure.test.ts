// @vitest-environment node
import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('ships only the background and sidepanel entrypoints', () => {
  expect(
    fs
      .readdirSync(path.join(root, 'entrypoints'))
      .filter((name) => !name.startsWith('.'))
      .sort(),
  ).toEqual(['background', 'sidepanel']);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(pkg.scripts.build).toBe('wxt build');
  expect(pkg.scripts.zip).toBe('wxt zip');
  for (const item of [
    'entrypoints/background/index.ts',
    'entrypoints/background/remote.ts',
    'entrypoints/sidepanel/index.html',
    'entrypoints/sidepanel/main.tsx',
    'components/RemotePanel.tsx',
    'assets/styles.css',
    'utils/automation/executor.ts',
  ])
    expect(fs.existsSync(path.join(root, item)), item).toBe(true);
});
