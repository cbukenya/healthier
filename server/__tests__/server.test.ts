import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

import { isAllowed, parseAccessList } from '../access';
import { ConfigError, loadConfig } from '../config';
import { apiRoutes } from '../api';
import { SESSION_COOKIE } from '../auth';
import type { Db } from '../db';
import { decrypt, encrypt } from '../crypto';
import { authorizationUrl, identityFromIdToken } from '../google';
import { failedStatus, GoogleRejected, ReconnectRequired } from '../sync';
import { GoogleAuthError } from '../google';
import { todayCivilIn } from '../../src/lib/date';
import type { StreamReport } from '../../src/types/health';

const VALID_ENV = {
  DATABASE_URL: 'postgres://healthier:pw@localhost:5432/healthier',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret',
};

describe('config', () => {
  it('lists every missing required variable at once', () => {
    assert.throws(
      () => loadConfig({}),
      (err: unknown) =>
        err instanceof ConfigError &&
        ['DATABASE_URL', 'ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].every((v) => err.missing.includes(v)),
    );
  });

  it('applies defaults when only the required values are set', () => {
    const config = loadConfig(VALID_ENV);
    assert.equal(config.port, 3000);
    assert.equal(config.appUrl, 'http://localhost:3000');
    assert.equal(config.syncIntervalMinutes, 60);
    assert.equal(config.historyDays, 730);
    assert.equal(config.encryptionKey.length, 32);
    assert.equal(config.demoMode, true);
  });

  it('strips a trailing slash from APP_URL so redirect URIs match exactly', () => {
    assert.equal(loadConfig({ ...VALID_ENV, APP_URL: 'https://health.example.com/' }).appUrl, 'https://health.example.com');
  });

  it('rejects an encryption key of the wrong length', () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, ENCRYPTION_KEY: randomBytes(16).toString('base64') }),
      (err: unknown) => err instanceof ConfigError && err.invalid.some((m) => m.startsWith('ENCRYPTION_KEY')),
    );
  });

  it('keeps at least the dashboard window of history', () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, HISTORY_DAYS: '30' }),
      (err: unknown) => err instanceof ConfigError && err.invalid.some((m) => m.startsWith('HISTORY_DAYS')),
    );
    assert.equal(loadConfig({ ...VALID_ENV, HISTORY_DAYS: '3650' }).historyDays, 3650);
  });

  it('hides demo mode with DEMO_MODE=false, and accepts only true or false', () => {
    assert.equal(loadConfig({ ...VALID_ENV, DEMO_MODE: 'false' }).demoMode, false);
    assert.equal(loadConfig({ ...VALID_ENV, DEMO_MODE: 'TRUE' }).demoMode, true);
    assert.throws(
      () => loadConfig({ ...VALID_ENV, DEMO_MODE: 'no' }),
      (err: unknown) => err instanceof ConfigError && err.invalid.some((m) => m.startsWith('DEMO_MODE')),
    );
  });

  it('reads the sign-in note, trimmed, and keeps it to a few sentences', () => {
    assert.equal(loadConfig(VALID_ENV).signInNote, null);
    assert.equal(loadConfig({ ...VALID_ENV, SIGN_IN_NOTE: '  Email me to join.  ' }).signInNote, 'Email me to join.');
    assert.throws(
      () => loadConfig({ ...VALID_ENV, SIGN_IN_NOTE: 'x'.repeat(601) }),
      (err: unknown) => err instanceof ConfigError && err.invalid.some((m) => m.startsWith('SIGN_IN_NOTE')),
    );
  });

  it('rejects malformed numbers and URLs', () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, PORT: 'abc', APP_URL: 'localhost:3000', SYNC_INTERVAL_MINUTES: '-5' }),
      (err: unknown) => err instanceof ConfigError && err.invalid.length === 3,
    );
  });
});

describe('instance', () => {
  it("tells the sign-in screen whether demo mode is offered, and the install's note, before anyone signs in", async () => {
    const app = express();
    app.use(cookieParser());
    // No route here may reach the database without a session, so it isn't given one.
    app.use('/api', apiRoutes({ config: loadConfig({ ...VALID_ENV, DEMO_MODE: 'false', SIGN_IN_NOTE: 'Email me to join.' }), db: {} as Db }));
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      const instance = await fetch(`${base}/instance`);
      assert.equal(instance.status, 200);
      assert.deepEqual(await instance.json(), { demo: false, note: 'Email me to join.' });
      assert.equal((await fetch(`${base}/me`)).status, 401, 'everything else still needs a session');
    } finally {
      server.close();
    }
  });
});

describe('theme', () => {
  it("keeps each person's theme on their account: dark, light or their device's, and nothing else", async () => {
    // A database with one signed-in person, enough for the session check, /me and the theme.
    let theme: string | null = null;
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM sessions')) return { rows: [{ userId: 'u1', email: 'a@example.com' }], rowCount: 1 };
        if (sql.startsWith('UPDATE users SET theme')) {
          theme = params[1] as string;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('FROM users')) return { rows: [{ id: 'u1', email: 'a@example.com', name: 'A', pictureUrl: null, theme }], rowCount: 1 };
        if (sql.includes('FROM google_tokens')) return { rows: [{}], rowCount: 1 };
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Db;
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api', apiRoutes({ config: loadConfig(VALID_ENV), db }));
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      const headers = { Cookie: `${SESSION_COOKIE}=token`, 'Content-Type': 'application/json' };
      const put = (body: unknown) => fetch(`${base}/theme`, { method: 'PUT', headers, body: JSON.stringify(body) });
      const me = async () => ((await (await fetch(`${base}/me`, { headers })).json()) as { theme: string | null }).theme;

      assert.equal(await me(), null, 'none until they pick one');
      const saved = await put({ theme: 'light' });
      assert.equal(saved.status, 200);
      assert.deepEqual(await saved.json(), { theme: 'light' });
      assert.equal(await me(), 'light');
      assert.equal((await put({ theme: 'system' })).status, 200);
      assert.equal(await me(), 'system');

      for (const wrong of ['blue', null, 1, undefined]) {
        const refused = await put({ theme: wrong });
        assert.equal(refused.status, 400);
        assert.deepEqual(await refused.json(), { error: 'invalid_theme' });
      }
      assert.equal(await me(), 'system', 'a refused theme changes nothing');
      assert.equal((await fetch(`${base}/theme`, { method: 'PUT', body: '{}' })).status, 401, 'only for someone signed in');
    } finally {
      server.close();
    }
  });
});

describe('token encryption', () => {
  const key = randomBytes(32);

  it('round-trips, with a fresh IV each time', () => {
    const a = encrypt(key, '1//refresh-token');
    const b = encrypt(key, '1//refresh-token');
    assert.notDeepEqual(a, b);
    assert.equal(decrypt(key, a), '1//refresh-token');
  });

  it('refuses tampered ciphertext', () => {
    const blob = encrypt(key, '1//refresh-token');
    blob[blob.length - 1] ^= 1;
    assert.throws(() => decrypt(key, blob));
  });

  it('refuses the wrong key', () => {
    assert.throws(() => decrypt(randomBytes(32), encrypt(key, 'secret')));
  });
});

describe('Google ID token', () => {
  const clientId = 'client-id.apps.googleusercontent.com';
  const now = Date.parse('2026-10-11T10:00:00Z');
  const token = (claims: object) =>
    `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const valid = { iss: 'https://accounts.google.com', aud: clientId, sub: '1234', exp: now / 1000 + 3600, email: 'a@b.c' };

  it('reads the identity from valid claims', () => {
    assert.deepEqual(identityFromIdToken(token({ ...valid, email_verified: true }), clientId, now), {
      sub: '1234',
      email: 'a@b.c',
      emailVerified: true,
      name: undefined,
      picture: undefined,
    });
  });

  it('rejects a token issued to another client', () => {
    assert.throws(() => identityFromIdToken(token({ ...valid, aud: 'other' }), clientId, now), /different client/);
  });

  it('rejects an expired token', () => {
    assert.throws(() => identityFromIdToken(token({ ...valid, exp: now / 1000 - 1 }), clientId, now), /expired/);
  });

  it('rejects a foreign issuer', () => {
    assert.throws(() => identityFromIdToken(token({ ...valid, iss: 'https://evil.example' }), clientId, now), /issuer/);
  });

  it('rejects garbage', () => {
    assert.throws(() => identityFromIdToken('not-a-jwt', clientId, now), /malformed/);
  });
});

describe('ALLOWED_EMAILS', () => {
  const { list, invalid } = parseAccessList('Alice@Example.com, bob@example.org  @family.se, nonsense');

  it('admits listed addresses case-insensitively, and whole @domains', () => {
    assert.ok(isAllowed(list, 'alice@example.com'));
    assert.ok(isAllowed(list, 'BOB@example.org'));
    assert.ok(isAllowed(list, 'grandma@family.se'));
  });

  it('turns away everyone else, and unverified addresses', () => {
    assert.ok(!isAllowed(list, 'eve@example.com'));
    assert.ok(!isAllowed(list, 'eve@notfamily.se'));
    assert.ok(!isAllowed(list, 'alice@example.com', false));
    assert.ok(!isAllowed(list, null));
  });

  it('lets anyone in when unset', () => {
    assert.ok(isAllowed(null, 'anyone@anywhere.com'));
  });

  it('reports entries it cannot read, and the config refuses to start on them', () => {
    assert.deepEqual(invalid, ['nonsense']);
    assert.throws(
      () => loadConfig({ ...VALID_ENV, ALLOWED_EMAILS: 'alice@example.com, nonsense' }),
      (err: unknown) => err instanceof ConfigError && err.invalid.some((m) => m.includes('nonsense')),
    );
  });
});

describe('authorization URL', () => {
  const client = { clientId: 'cid', clientSecret: 's', redirectUri: 'http://localhost:3000/auth/callback' };

  it('asks for offline access, identity and the health scopes', () => {
    const url = new URL(authorizationUrl(client, 'state123', { consent: false }));
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('state'), 'state123');
    assert.equal(url.searchParams.get('redirect_uri'), client.redirectUri);
    const scopes = url.searchParams.get('scope')!.split(' ');
    assert.ok(scopes.includes('openid'));
    assert.ok(scopes.some((s) => s.includes('googlehealth.sleep')));
    // Age on the Body page comes from the Google Health profile, behind its own scope.
    assert.ok(scopes.includes('https://www.googleapis.com/auth/googlehealth.profile.readonly'));
    assert.equal(url.searchParams.get('prompt'), null);
  });

  it('forces the consent screen only when asked', () => {
    const url = new URL(authorizationUrl(client, 's', { consent: true }));
    assert.equal(url.searchParams.get('prompt'), 'consent');
  });
});

describe('todayCivilIn', () => {
  // 23:30 UTC on the 10th is already the 11th in Stockholm (UTC+2 in October).
  const instant = new Date('2026-10-10T23:30:00Z');

  it('resolves the civil date in the given zone, not the process zone', () => {
    assert.equal(todayCivilIn('UTC', instant), '2026-10-10');
    assert.equal(todayCivilIn('Europe/Stockholm', instant), '2026-10-11');
    assert.equal(todayCivilIn('America/Los_Angeles', instant), '2026-10-10');
  });
});

describe('a failed sync', () => {
  const report = (fields: Partial<StreamReport>): StreamReport => ({
    dataType: 'steps', label: 'Steps', domain: 'movement', mode: 'rollup', status: 'unauthorized',
    observations: 0, requests: 5, pagesFetched: 5, truncated: false, ms: 120, httpStatus: 403, ...fields,
  });

  it("sends Google's own words when it refused every request; the browser says the rest", () => {
    const google = '403 PERMISSION_DENIED: Google Health API has not been used in project 1 before or it is disabled.';
    assert.deepEqual(failedStatus(new GoogleRejected(report({ error: google }))), { error: google, errorCode: 'google_rejected' });
  });

  it('sends the stream’s code and what it needs when Google said nothing', () => {
    assert.deepEqual(failedStatus(new GoogleRejected(report({ errorCode: 'http', error: '403' }))), {
      error: '403',
      errorCode: 'google_rejected',
      streamErrorCode: 'http',
    });
    // Never a null error: pages opened before errorCode existed look for one.
    assert.deepEqual(failedStatus(new GoogleRejected(report({ status: 'error', errorCode: 'network' }))), {
      error: 'network',
      errorCode: 'google_rejected',
      streamErrorCode: 'network',
    });
    assert.deepEqual(failedStatus(new GoogleRejected(report({}))), { error: '403', errorCode: 'google_rejected', streamErrorCode: 'http' });
  });

  it('names a lapsed Google connection and a refused token, and sends anything else as its own message', () => {
    assert.deepEqual(failedStatus(new ReconnectRequired()), { error: 'reconnect_required', errorCode: 'reconnect_required' });
    assert.deepEqual(failedStatus(new GoogleAuthError('http_503', 503)), { error: '503', errorCode: 'token_refresh_failed' });
    const described = new GoogleAuthError('invalid_client', 401, 'The OAuth client was not found.');
    assert.deepEqual(failedStatus(described), { error: 'The OAuth client was not found.', errorCode: null });
    assert.deepEqual(failedStatus(new Error('connect ECONNREFUSED 127.0.0.1:5432')), { error: 'connect ECONNREFUSED 127.0.0.1:5432', errorCode: null });
    assert.deepEqual(failedStatus('boom'), { error: 'boom', errorCode: null });
  });
});
