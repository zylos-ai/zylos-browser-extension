// OAuth 2.0 PKCE (RFC 7636) helpers for the OpenMax Workspace sign-in.
// The verifier never leaves the service worker; only its S256 challenge is sent.

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes → 43 base64url characters (the RFC 7636 minimum length, max entropy). */
export function generateCodeVerifier(random: (n: number) => Uint8Array = randomBytes): string {
  return base64Url(random(32));
}

export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function generateState(random: (n: number) => Uint8Array = randomBytes): string {
  return base64Url(random(24));
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
