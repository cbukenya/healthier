import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { isAllowed, parseAccessList } from '../access';
import { ConfigError, loadConfig } from '../config';
import { decrypt, encrypt } from '../crypto';
import { authorizationUrl, identityFromIdToken } from '../google';
import { todayCivilIn } from '../../src/lib/date';

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
    assert.equal(config.encryptionKey.length, 32);
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

  it('rejects malformed numbers and URLs', () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, PORT: 'abc', APP_URL: 'localhost:3000', SYNC_INTERVAL_MINUTES: '-5' }),
      (err: unknown) => err instanceof ConfigError && err.invalid.length === 3,
    );
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
