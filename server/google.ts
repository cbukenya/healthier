import { SCOPES } from '../src/pipeline/registry';
import type { Config } from './config';

/**
 * Google OAuth, server side.
 *
 * The authorization-code flow with a client secret is what makes background sync
 * possible: it yields a refresh token the server keeps, so data can be fetched
 * while no browser is open. Firebase's popup sign-in only ever returned a
 * one-hour access token to the browser.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Identity for the account row, plus every Google Health scope the pipeline reads. */
export const LOGIN_SCOPES = ['openid', 'email', 'profile', ...Object.values(SCOPES)];

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleClient(config: Config): GoogleClient {
  return {
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: `${config.appUrl}/auth/callback`,
  };
}

export function authorizationUrl(client: GoogleClient, state: string, opts: { consent: boolean }): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: LOGIN_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    state,
  });
  // Google issues a refresh token only on a consent screen. Returning users skip
  // it, and are sent back with consent forced only when we hold no token for them.
  if (opts.consent) params.set('prompt', 'consent');
  return `${AUTH_URL}?${params}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  /** Space-separated scopes actually granted; users can untick some on the consent screen. */
  scope?: string;
  id_token?: string;
}

export class GoogleAuthError extends Error {
  /**
   * Google's error code, e.g. `invalid_grant` when a refresh token is revoked or expired; its HTTP
   * status; and its own description, when it sent one.
   */
  constructor(readonly code: string, readonly status: number, readonly description?: string) {
    super(description ?? `Token request failed (${status})`);
    this.name = 'GoogleAuthError';
  }
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GoogleAuthError(body.error ?? `http_${res.status}`, res.status, body.error_description);
  }
  return body as TokenResponse;
}

export function exchangeCode(client: GoogleClient, code: string): Promise<TokenResponse> {
  return tokenRequest({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    grant_type: 'authorization_code',
  });
}

export function refreshAccessToken(client: GoogleClient, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: 'refresh_token',
  });
}

/** Best effort: the user's data is deleted whether or not Google acknowledges. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch (err) {
    console.warn('Google token revocation failed:', err);
  }
}

export interface GoogleIdentity {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * Read the account from the ID token in a token response.
 *
 * The token came straight from Google's token endpoint over TLS, so OpenID
 * Connect (Core §3.1.3.7) allows skipping the signature check; the claims that
 * bind it to this app and this moment are still verified.
 */
export function identityFromIdToken(idToken: string, clientId: string, now = Date.now()): GoogleIdentity {
  let claims: any;
  try {
    claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    throw new Error('ID token is malformed');
  }
  if (claims?.aud !== clientId) throw new Error('ID token was issued to a different client');
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
    throw new Error('ID token has an unexpected issuer');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) throw new Error('ID token has expired');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('ID token has no subject');
  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: claims.name,
    picture: claims.picture,
  };
}
