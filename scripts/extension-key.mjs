// Fixed extension ID for packages installed outside the Chrome Web Store.
//
// Chrome derives an unpacked/manually installed extension's ID from the
// manifest `key` (a public key); without it the ID comes from the install
// folder path. OpenMax Workspace only accepts sign-in from allowlisted IDs:
// the Web Store ID and RELEASE_EXTENSION_ID below. This is the public key
// that release 0.18.0 shipped; there is no matching private key in use and
// none is needed. The Web Store assigns its own ID and rejects `key`.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export const RELEASE_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApV22ekNEGqthFbY0ECX3ZjoU2+ih1IDYi+boRQYcp0qhsEpbK0DTfSlZnR1wJ5yfTkMWRuXy9aRrx1hcO7K6VMmi28XI8V3vqWE0ePgYVNVi04B3TgRYxGvKKxVZFVjXl1IjID+Vx1yX4YuS6hJXH5uvanzXZx6Ya5zYEWVVaT3Swvx1uvriS8TNaTO/vGMKLZHTOBvZ9uwuMsH3RUk32SY3A+r0OnZ1lE848nxEeQLXqLs92Fax4gtHbU2rpK6GS1Z9UuyyK8dZMPGjs0ov9EZiia7pcPTrj8ulrz8KgavpGEnakiN4Ko5ZMx23Gu28aW+Y1IhN8hmnQNvDdEkJuQIDAQAB';
export const RELEASE_EXTENSION_ID = 'fedaknpgpclnololpbanedpbhlfdbhlp';
export const STORE_EXTENSION_ID = 'mehokihmomodpmdghdeajmgpphncanae';

/** Chrome's ID: SHA-256 of the DER public key, first 32 hex digits mapped 0-f → a-p. */
export function extensionIdFromKey(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * WXT_MANIFEST_KEY selects the manifest `key`:
 * - `release`: fixed key (GitHub release zip, manual/INT test installs);
 * - `store`: no key (Chrome Web Store upload);
 * - unset: no key (dev and test builds), but `wxt zip` requires an explicit choice.
 */
export function manifestKeyMode(env = process.env, command = '') {
  const value = env.WXT_MANIFEST_KEY?.trim() ?? '';
  if (value === 'release' || value === 'store') return value;
  if (value) throw new Error(`WXT_MANIFEST_KEY: expected "release" or "store", got "${value}"`);
  if (command === 'zip')
    throw new Error(
      'Packaging needs an explicit target: npm run zip:github (fixed extension ID ' +
        `${RELEASE_EXTENSION_ID}, GitHub release) or npm run zip:store (Chrome Web Store upload).`,
    );
  return undefined;
}

export function manifestKey(mode) {
  return mode === 'release' ? RELEASE_EXTENSION_KEY : undefined;
}

/** Throws unless the manifest matches the packaging mode. */
export function assertManifestKey(manifest, mode) {
  if (mode === 'release') {
    if (typeof manifest?.key !== 'string' || !manifest.key)
      throw new Error('Release manifest has no "key"; the extension ID would not be fixed.');
    const id = extensionIdFromKey(manifest.key);
    if (id !== RELEASE_EXTENSION_ID)
      throw new Error(
        `Release manifest key gives extension ID ${id}, not ${RELEASE_EXTENSION_ID}.`,
      );
    return id;
  }
  if (mode === 'store' && manifest && 'key' in manifest)
    throw new Error('Chrome Web Store manifest must not contain "key".');
  return undefined;
}

/** Reads one stored or deflated file from a zip archive (no ZIP64). */
export function readZipEntry(zipPath, name) {
  const zip = fs.readFileSync(zipPath);
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`${zipPath}: not a zip archive`);
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`${zipPath}: bad central directory`);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`${zipPath}: unsupported compression ${method} for ${name}`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${zipPath}: ${name} not found`);
}

/** Verifies the packaged manifest; returns the fixed ID in release mode. */
export function assertZipManifestKey(zipPath, mode) {
  const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json').toString('utf8'));
  return assertManifestKey(manifest, mode);
}
