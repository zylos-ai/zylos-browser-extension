// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { extensionBuild, extensionVersion } from '../../utils/extension-build';
import { describeTools } from '../../utils/tool-catalog';

afterEach(() => vi.unstubAllGlobals());

it('uses the installed manifest version for the tool catalog', () => {
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.17.1' }) } });
  expect(extensionVersion()).toBe('0.17.1');
  expect(describeTools([]).extensionVersion).toBe('0.17.1');
});

it('reports unavailable instead of inventing a missing manifest version', () => {
  vi.stubGlobal('chrome', undefined);
  expect(extensionVersion()).toBe('unavailable');
});

it('exports only validated bounded build fields', () => {
  const build = {
    id: '11111111-1111-4111-8111-111111111111',
    commit: 'a'.repeat(40),
    dirty: true,
    builtAt: '2026-10-23T12:00:00.000Z',
  };
  expect(extensionBuild(JSON.stringify({ ...build, token: 'secret', url: 'private' }))).toEqual(
    build,
  );
  expect(extensionBuild(JSON.stringify({ ...build, commit: 'unavailable' }))).toEqual({
    id: build.id,
    dirty: true,
    builtAt: build.builtAt,
  });
  expect(extensionBuild('not JSON')).toBeUndefined();
  expect(extensionBuild(JSON.stringify({ commit: build.commit, dirty: true }))).toBeUndefined();
  expect(extensionBuild(JSON.stringify({ ...build, id: 'invalid' }))).toBeUndefined();
  expect(extensionBuild('x'.repeat(1025))).toBeUndefined();
  expect(
    extensionBuild(
      JSON.stringify({ id: 'bad', commit: 'a'.repeat(41), dirty: 'yes', builtAt: 'invalid' }),
    ),
  ).toBeUndefined();
});
