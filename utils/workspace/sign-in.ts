// OpenMax Workspace sign-in: OAuth 2.0 authorization code + PKCE S256 through
// chrome.identity.launchWebAuthFlow (Workspace consent page → Allow).
import { WORKSPACE_CLIENT_ID, WORKSPACE_SCOPE } from './config';
import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce';
import { TokenStore, WorkspaceAuthError, type TokenResponse } from './token-store';

export interface SignInDeps {
  baseUrl: string;
  redirectUri: string;
  launch: (url: string) => Promise<string | undefined>;
  fetch: typeof fetch;
  tokens: TokenStore;
}

export async function buildAuthorizeUrl(
  baseUrl: string,
  redirectUri: string,
  verifier: string,
  state: string,
): Promise<string> {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: WORKSPACE_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    code_challenge: await codeChallengeS256(verifier),
    code_challenge_method: 'S256',
    scope: WORKSPACE_SCOPE,
  });
  return `${baseUrl}/api/v1/browser-extension/oauth/authorize?${query}`;
}

/** Returns normally once tokens are stored; throws `cancelled`, `denied` or a failure code. */
export async function signIn(deps: SignInDeps): Promise<void> {
  if (!deps.baseUrl) throw new Error('ui.error.workspaceUrlRequired');
  const verifier = generateCodeVerifier();
  const state = generateState();
  const url = await buildAuthorizeUrl(deps.baseUrl, deps.redirectUri, verifier, state);
  let redirect: string | undefined;
  try {
    redirect = await deps.launch(url);
  } catch (e) {
    // Chrome reports a closed window as "did not approve"; anything else (for example
    // "Authorization page could not be loaded") means the Workspace sign-in page is unavailable.
    throw new Error(
      /did not approve/i.test(String((e as Error)?.message ?? e))
        ? 'ui.error.workspaceSignInCancelled'
        : 'ui.error.workspaceSignInUnavailable',
    );
  }
  if (!redirect) throw new Error('ui.error.workspaceSignInCancelled');
  const result = new URL(redirect);
  if (`${result.origin}${result.pathname}` !== deps.redirectUri.replace(/\/?$/, '/'))
    throw new Error('ui.error.workspaceSignInFailed');
  if (result.searchParams.get('state') !== state) throw new Error('ui.error.workspaceSignInFailed');
  const error = result.searchParams.get('error');
  if (error === 'access_denied') throw new Error('ui.error.workspaceSignInDenied');
  const code = result.searchParams.get('code');
  if (error || !code) throw new Error('ui.error.workspaceSignInFailed');
  let res: Response;
  try {
    res = await deps.fetch(`${deps.baseUrl}/api/v1/browser-extension/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: deps.redirectUri,
        code_verifier: verifier,
        client_id: WORKSPACE_CLIENT_ID,
      }),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    throw new Error('ui.error.workspaceUnreachable');
  }
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse>;
  if (!res.ok || !body.access_token || !body.refresh_token)
    throw new Error('ui.error.workspaceSignInFailed');
  await deps.tokens.save(body as TokenResponse);
}

/** Best-effort server revoke of the whole sign-in, then local clear. */
export async function signOut(deps: { baseUrl: string; fetch: typeof fetch; tokens: TokenStore }) {
  const current = await deps.tokens.load();
  await deps.tokens.clear();
  if (!current) return;
  await deps
    .fetch(`${deps.baseUrl}/api/v1/browser-extension/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: current.refreshToken, client_id: WORKSPACE_CLIENT_ID }),
      cache: 'no-store',
      credentials: 'omit',
    })
    .catch(() => undefined);
}

export { WorkspaceAuthError };
