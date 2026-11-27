export type ManifestKeyMode = 'release' | 'store';

export const RELEASE_EXTENSION_KEY: string;
export const RELEASE_EXTENSION_ID: string;
export const STORE_EXTENSION_ID: string;
export function extensionIdFromKey(key: string): string;
export function manifestKeyMode(
  env?: Record<string, string | undefined>,
  command?: string,
): ManifestKeyMode | undefined;
export function manifestKey(mode: ManifestKeyMode | undefined): string | undefined;
export function assertManifestKey(
  manifest: unknown,
  mode: ManifestKeyMode | undefined,
): string | undefined;
export function readZipEntry(zipPath: string, name: string): Buffer;
export function assertZipManifestKey(
  zipPath: string,
  mode: ManifestKeyMode | undefined,
): string | undefined;
