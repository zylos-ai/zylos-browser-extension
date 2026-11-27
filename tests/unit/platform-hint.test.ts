// @vitest-environment node
import { expect, test } from 'vitest';
import { platformHint, platformLabel, readPlatformHint } from '../../utils/platform-hint';

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.60 Safari/537.36';
const WIN_EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.71';
const brands = (...list: [string, string][]) =>
  list.map(([brand, version]) => ({ brand, version }));

test('platform info + userAgentData give "macOS · arm64 · Chrome 142"', () => {
  const hint = platformHint(
    { os: 'mac', arch: 'arm64' },
    {
      userAgent: MAC_UA,
      userAgentData: {
        brands: brands(['Chromium', '142'], ['Google Chrome', '142'], ['Not_A Brand', '99']),
      },
    },
  );
  expect(hint).toEqual({ os: 'macOS', arch: 'arm64', browser: 'Chrome', browserVersion: '142' });
  expect(platformLabel(hint)).toBe('macOS · arm64 · Chrome 142');
});

test('other browsers and OSes are named from brands, then from the user agent', () => {
  expect(
    platformLabel(
      platformHint(
        { os: 'win', arch: 'x86-64' },
        { userAgentData: { brands: brands(['Microsoft Edge', '141'], ['Chromium', '141']) } },
      ),
    ),
  ).toBe('Windows · x86-64 · Edge 141');
  // No userAgentData: browser and major version from the UA string.
  expect(
    platformLabel(platformHint({ os: 'win', arch: 'x86-64' }, { userAgent: WIN_EDGE_UA })),
  ).toBe('Windows · x86-64 · Edge 141');
  // Unknown brand: Chromium's version is used.
  expect(
    platformHint(
      { os: 'linux', arch: 'x86-64' },
      { userAgent: 'x Chrome/140.1 y', userAgentData: { brands: brands(['Chromium', '140']) } },
    ),
  ).toEqual({ os: 'Linux', arch: 'x86-64', browser: 'Chrome', browserVersion: '140' });
  expect(platformHint({ os: 'cros', arch: 'arm' }, {}).os).toBe('ChromeOS');
});

test('without getPlatformInfo the OS comes from the user agent and the arch is omitted', () => {
  expect(platformLabel(platformHint(undefined, { userAgent: MAC_UA }))).toBe('macOS · Chrome 142');
});

test('unknown or malformed values are dropped rather than passed through', () => {
  expect(
    platformHint(
      { os: 'beos', arch: 'z80' },
      { userAgent: 'Node.js/22', userAgentData: { brands: brands(['Google Chrome', 'abc']) } },
    ),
  ).toEqual({ browser: 'Chrome' });
  expect(platformHint(undefined, { userAgent: 'Node.js/22' })).toEqual({});
  expect(platformLabel({})).toBe('');
  expect(platformLabel(undefined)).toBe('');
});

test('readPlatformHint falls back when getPlatformInfo is missing or fails', async () => {
  expect(await readPlatformHint(async () => ({ os: 'mac', arch: 'arm64' }))).toMatchObject({
    os: 'macOS',
    arch: 'arm64',
  });
  const failed = await readPlatformHint(async () => {
    throw new Error('nope');
  });
  expect(failed.arch).toBeUndefined();
  expect((await readPlatformHint(undefined)).arch).toBeUndefined();
});
