import { loadConfig } from './config';

/**
 * Merchant sign-in through Cognito managed login, authorization-code flow with PKCE.
 * Tokens live in sessionStorage: they vanish with the tab, and managed login's own cookie makes re-entry quick.
 */

interface Session {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  email?: string;
}

const SESSION = 'dd.session';
const PKCE = 'dd.pkce';
const SCOPES = 'openid email profile';

const store = {
  get(key: string): string | null {
    try { return sessionStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string) {
    try { sessionStorage.setItem(key, value); } catch { /* private mode: sign-in lasts for this page only */ }
  },
  remove(key: string) {
    try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  },
};

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

const redirectUri = () => `${window.location.origin}/m/callback/`;

function readSession(): Session | null {
  const raw = store.get(SESSION);
  if (!raw) return null;
  try { return JSON.parse(raw) as Session; } catch { return null; }
}

/** Email from the ID token's payload; display only, so the signature is not checked here (the API checks tokens). */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  try {
    const payload = JSON.parse(atob(idToken!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { email?: string };
    return payload.email;
  } catch {
    return undefined;
  }
}

async function tokenRequest(params: Record<string, string>): Promise<Session> {
  const cfg = await loadConfig();
  const r = await fetch(`${cfg.authDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.userPoolClientId, ...params }),
  });
  if (!r.ok) throw new Error(`Sign-in failed (${r.status})`);
  const t = (await r.json()) as { access_token: string; id_token?: string; refresh_token?: string; expires_in: number };
  const previous = readSession();
  const session: Session = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
    email: emailFromIdToken(t.id_token) ?? previous?.email,
  };
  store.set(SESSION, JSON.stringify(session));
  return session;
}

/**
 * `returnTo` is a same-site path to land on after sign-in (the console, or /ops/). `screen: 'signup'` opens managed
 * login on its create-account form (the /signup endpoint takes the same parameters as /oauth2/authorize).
 */
export async function signIn(returnTo = '/m/', screen: 'signin' | 'signup' = 'signin'): Promise<void> {
  if (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_DROPDECK_DEMO === '1') { location.assign('/m/'); return; }
  const cfg = await loadConfig();
  const verifier = randomString();
  const state = randomString();
  store.set(PKCE, JSON.stringify({ verifier, state, returnTo }));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.userPoolClientId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.assign(`${cfg.authDomain}/${screen === 'signup' ? 'signup' : 'oauth2/authorize'}?${q}`);
}

/** Only a path on this site, never another origin (`//evil.example` or `https://…`). */
const safePath = (p: unknown) => (typeof p === 'string' && /^\/(?!\/)[\w\-/?=&.]*$/.test(p) ? p : '/m/');

/** Runs on /m/callback/: swaps the code for tokens, and returns where to go next. */
export async function completeSignIn(search: string): Promise<string> {
  const q = new URLSearchParams(search);
  const error = q.get('error_description') ?? q.get('error');
  if (error) throw new Error(error);
  const pkce = JSON.parse(store.get(PKCE) ?? 'null') as { verifier: string; state: string; returnTo?: string } | null;
  store.remove(PKCE);
  const code = q.get('code');
  if (!code || !pkce || q.get('state') !== pkce.state) throw new Error('Sign-in link expired; please try again.');
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pkce.verifier });
  return safePath(pkce.returnTo);
}

/** A valid access token, refreshed when within a minute of expiry; null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  if (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_DROPDECK_DEMO === '1') return new URLSearchParams(location.search).get('preview') === 'signed-out' ? null : 'local-preview';
  const s = readSession();
  if (!s) return null;
  if (s.expiresAt - Date.now() > 60_000) return s.accessToken;
  if (!s.refreshToken) return null;
  try {
    return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refreshToken })).accessToken;
  } catch {
    store.remove(SESSION);
    return null;
  }
}

export const signedInEmail = () => readSession()?.email;

/** Cognito groups from the access token, for showing or hiding operator screens. The API checks them for real. */
export function signedInGroups(): string[] {
  const token = readSession()?.accessToken;
  try {
    const payload = JSON.parse(atob(token!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { 'cognito:groups'?: string[] };
    return payload['cognito:groups'] ?? [];
  } catch {
    return [];
  }
}

/** Drop a token the API rejected, so the console falls back to the sign-in screen instead of retrying it. */
export const clearSession = () => store.remove(SESSION);

export async function signOut(): Promise<void> {
  if (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_DROPDECK_DEMO === '1') { location.assign('/m/?preview=signed-out'); return; }
  store.remove(SESSION);
  const cfg = await loadConfig();
  const q = new URLSearchParams({ client_id: cfg.userPoolClientId, logout_uri: `${window.location.origin}/m/` });
  window.location.assign(`${cfg.authDomain}/logout?${q}`);
}
