import { Router, type CookieOptions, type RequestHandler } from 'express';
import { isAllowed } from './access';
import { randomToken } from './crypto';
import { authorizationUrl, exchangeCode, googleClient, identityFromIdToken, revokeToken } from './google';
import { asyncHandler, type Deps } from './http';
import { createSession, deleteSession, findSessionUser, hasTokens, requestFullSync, saveTokens, upsertUser } from './repo';

/**
 * Sign-in with Google and the session cookie.
 *
 * Signing in and connecting health data are one step: the consent screen asks
 * for the account and the Google Health scopes together, and the callback both
 * creates the session and stores the tokens that background sync runs on.
 */

export const SESSION_COOKIE = 'healthier_session';
const STATE_COOKIE = 'healthier_oauth_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

export function sessionCookieOptions(deps: Deps, maxAge?: number): CookieOptions {
  return {
    httpOnly: true,
    // Lax still sends the cookie on the redirect back from Google, and keeps it
    // off cross-site POSTs, which is the CSRF protection for the API.
    sameSite: 'lax',
    secure: deps.config.appUrl.startsWith('https://'),
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

export function authRoutes(deps: Deps): Router {
  const router = Router();
  const client = googleClient(deps.config);

  router.get('/auth/google', (req, res) => {
    const consent = req.query.consent === '1';
    const state = randomToken(16);
    // The consent flag rides along so the callback knows whether a retry is still possible.
    res.cookie(STATE_COOKIE, `${state}.${consent ? 1 : 0}`, {
      ...sessionCookieOptions(deps, STATE_TTL_MS),
      path: '/auth',
    });
    res.redirect(authorizationUrl(client, state, { consent }));
  });

  router.get(
    '/auth/callback',
    asyncHandler(async (req, res) => {
      const fail = (code: string) => res.redirect(`/?auth_error=${encodeURIComponent(code)}`);
      const [expectedState, consentFlag] = String(req.cookies[STATE_COOKIE] ?? '').split('.');
      res.clearCookie(STATE_COOKIE, { ...sessionCookieOptions(deps), path: '/auth' });

      if (typeof req.query.error === 'string') return fail(req.query.error);
      const { code, state } = req.query;
      if (typeof code !== 'string' || typeof state !== 'string' || !expectedState || state !== expectedState) {
        return fail('invalid_state');
      }

      try {
        const tokens = await exchangeCode(client, code);
        if (!tokens.id_token) throw new Error('Token response had no ID token');
        const identity = identityFromIdToken(tokens.id_token, client.clientId);
        if (!isAllowed(deps.config.allowedEmails, identity.email, identity.emailVerified)) {
          // Not on this instance's list: hand back the access Google just granted.
          await revokeToken(tokens.refresh_token ?? tokens.access_token);
          return fail('not_invited');
        }
        const userId = await upsertUser(deps.db, identity);

        if (!tokens.refresh_token && !(await hasTokens(deps.db, userId))) {
          // Google skips the consent screen for returning users and then withholds
          // the refresh token. Ask again with consent forced, once.
          return consentFlag === '1' ? fail('no_refresh_token') : res.redirect('/auth/google?consent=1');
        }

        await saveTokens(deps.db, deps.config.encryptionKey, userId, {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          scopes: tokens.scope?.split(' '),
        });
        // Granted scopes may have changed on the consent screen: rebuild everything.
        await requestFullSync(deps.db, userId);
        const session = await createSession(deps.db, userId, SESSION_TTL_MS);
        res.cookie(SESSION_COOKIE, session, sessionCookieOptions(deps, SESSION_TTL_MS));
        res.redirect('/');
      } catch (err) {
        console.error('Google sign-in failed:', err);
        fail('callback_failed');
      }
    }),
  );

  router.post(
    '/auth/logout',
    asyncHandler(async (req, res) => {
      const token = req.cookies[SESSION_COOKIE];
      if (typeof token === 'string') await deleteSession(deps.db, token);
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions(deps));
      res.json({ ok: true });
    }),
  );

  return router;
}

/** Rejects with 401 unless the request carries a live session; sets `res.locals.userId`. */
export function requireUser(deps: Deps): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const token = req.cookies[SESSION_COOKIE];
    const session = typeof token === 'string' ? await findSessionUser(deps.db, token) : null;
    // Removing someone from ALLOWED_EMAILS ends their access at once, not when the session expires.
    if (!session || !isAllowed(deps.config.allowedEmails, session.email)) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    res.locals.userId = session.userId;
    next();
  });
}
