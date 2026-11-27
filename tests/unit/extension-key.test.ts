// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../../wxt.config';
import {
  RELEASE_EXTENSION_ID,
  RELEASE_EXTENSION_KEY,
  assertManifestKey,
  assertZipManifestKey,
  extensionIdFromKey,
  manifestKeyMode,
} from '../../scripts/extension-key.mjs';

afterEach(() => vi.unstubAllEnvs());

type ManifestFn = (env: Record<string, unknown>) => Record<string, unknown>;
const manifest = () =>
  (config.manifest as ManifestFn)({
    mode: 'production',
    command: 'build',
    browser: 'chrome',
    manifestVersion: 3,
  });

describe('extension ID', () => {
  it('derives the fixed manual-install ID from the release public key', () => {
    expect(extensionIdFromKey(RELEASE_EXTENSION_KEY)).toBe('fedaknpgpclnololpbanedpbhlfdbhlp');
    expect(RELEASE_EXTENSION_ID).toBe('fedaknpgpclnololpbanedpbhlfdbhlp');
  });

  it('maps the first 32 hex digits of the SHA-256 to a-p', () => {
    const der = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64');
    const id = extensionIdFromKey(der);
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(id).not.toBe(RELEASE_EXTENSION_ID);
    // SHA-256 of empty input is e3b0c44298fc1c149afbf4c8996fb924…; e→o, 3→d, b→l, 0→a …
    expect(extensionIdFromKey('')).toBe('odlameecjipmbmbejkplpemijjgpljce');
  });
});

describe('manifest key mode', () => {
  it('accepts release and store, rejects anything else', () => {
    expect(manifestKeyMode({ WXT_MANIFEST_KEY: 'release' })).toBe('release');
    expect(manifestKeyMode({ WXT_MANIFEST_KEY: ' store ' })).toBe('store');
    expect(manifestKeyMode({})).toBeUndefined();
    expect(() => manifestKeyMode({ WXT_MANIFEST_KEY: 'github' })).toThrow(/release.*store/);
  });

  it('requires an explicit target when packaging', () => {
    expect(() => manifestKeyMode({}, 'zip')).toThrow(/zip:github.*zip:store/);
    expect(manifestKeyMode({}, 'build')).toBeUndefined();
    expect(manifestKeyMode({ WXT_MANIFEST_KEY: 'release' }, 'zip')).toBe('release');
  });
});

describe('wxt manifest hook', () => {
  it('adds the fixed key for release packaging', () => {
    vi.stubEnv('WXT_MANIFEST_KEY', 'release');
    const result = manifest();
    expect(result.key).toBe(RELEASE_EXTENSION_KEY);
    expect(assertManifestKey(result, 'release')).toBe(RELEASE_EXTENSION_ID);
  });

  it('omits the key for the Chrome Web Store and for plain builds', () => {
    vi.stubEnv('WXT_MANIFEST_KEY', 'store');
    expect(manifest()).not.toHaveProperty('key');
    vi.stubEnv('WXT_MANIFEST_KEY', '');
    expect(manifest()).not.toHaveProperty('key');
  });
});

describe('packaged manifest check', () => {
  it('rejects a release manifest without the key or with another key', () => {
    expect(() => assertManifestKey({ name: 'x' }, 'release')).toThrow(/no "key"/);
    const other = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64');
    expect(() => assertManifestKey({ key: other }, 'release')).toThrow(RELEASE_EXTENSION_ID);
    expect(() => assertManifestKey({ key: RELEASE_EXTENSION_KEY }, 'store')).toThrow(/Web Store/);
    expect(assertManifestKey({ name: 'x' }, 'store')).toBeUndefined();
  });

  it('reads manifest.json from the zip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-key-'));
    try {
      const withKey = path.join(dir, 'release.zip');
      const withoutKey = path.join(dir, 'store.zip');
      fs.writeFileSync(
        withKey,
        zip({ 'manifest.json': JSON.stringify({ key: RELEASE_EXTENSION_KEY }) }),
      );
      fs.writeFileSync(withoutKey, zip({ 'a.js': '1', 'manifest.json': '{"name":"x"}' }));
      expect(assertZipManifestKey(withKey, 'release')).toBe(RELEASE_EXTENSION_ID);
      expect(() => assertZipManifestKey(withKey, 'store')).toThrow(/Web Store/);
      expect(() => assertZipManifestKey(withoutKey, 'release')).toThrow(/no "key"/);
      expect(assertZipManifestKey(withoutKey, 'store')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Minimal deflate zip writer (CRC left zero; the reader does not check it). */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(text.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
