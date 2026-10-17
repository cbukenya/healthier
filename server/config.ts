/**
 * Runtime configuration.
 *
 * Every setting the app needs is read here, once, from the environment, so a
 * self-hoster has exactly one place to look (`.env.example`) and one image that
 * works for everyone. Nothing is baked in at build time.
 *
 * Missing or malformed values stop the server at boot with a list of what to
 * fix, rather than surfacing later as a failed sign-in or an opaque crypto error.
 */

import { DASHBOARD_WINDOW_DAYS, DEFAULT_HISTORY_DAYS } from '../src/pipeline/incremental';
import { parseAccessList, type AccessList } from './access';

type Env = Record<string, string | undefined>;

/** The sign-in note is a sentence or two under a button, not a page. */
const MAX_SIGN_IN_NOTE = 600;

export interface Config {
  port: number;
  /** Public base URL the app is reached at; OAuth redirects are built from it. */
  appUrl: string;
  isProduction: boolean;
  databaseUrl: string;
  /** 32-byte key for encrypting Google tokens at rest. */
  encryptionKey: Buffer;
  google: {
    clientId: string;
    clientSecret: string;
  };
  /** Minutes between background syncs per user. 0 turns background sync off. */
  syncIntervalMinutes: number;
  /** Days of daily history kept and backfilled per user. */
  historyDays: number;
  /** Who may sign up; null lets anyone through Google's consent screen. */
  allowedEmails: AccessList | null;
  /** Whether the sign-in screen offers demo mode. */
  demoMode: boolean;
  /** This install's own note under the sign-in buttons, such as how to join; null for none. */
  signInNote: string | null;
}

export class ConfigError extends Error {
  constructor(readonly missing: string[], readonly invalid: string[]) {
    super(
      [
        'Invalid configuration.',
        ...missing.map((name) => `  missing: ${name}`),
        ...invalid.map((msg) => `  invalid: ${msg}`),
        'Copy .env.example to .env and fill in the required values.',
      ].join('\n'),
    );
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Env = process.env): Config {
  const missing: string[] = [];
  const invalid: string[] = [];

  const optional = (name: string) => env[name]?.trim() || undefined;
  const required = (name: string) => {
    const value = optional(name);
    if (!value) missing.push(name);
    return value ?? '';
  };
  const flag = (name: string, fallback: boolean) => {
    const raw = optional(name);
    if (raw === undefined) return fallback;
    if (/^true$/i.test(raw)) return true;
    if (/^false$/i.test(raw)) return false;
    invalid.push(`${name} must be true or false, got "${raw}"`);
    return fallback;
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = optional(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      invalid.push(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
    }
    return value;
  };

  const port = integer('PORT', 3000, 1, 65535);

  const appUrl = (optional('APP_URL') ?? `http://localhost:${port}`).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(appUrl)) {
    invalid.push(`APP_URL must start with http:// or https://, got "${appUrl}"`);
  }

  const rawKey = required('ENCRYPTION_KEY');
  const encryptionKey = Buffer.from(rawKey, 'base64');
  if (rawKey && encryptionKey.length !== 32) {
    invalid.push('ENCRYPTION_KEY must be 32 bytes, base64-encoded. Generate one with: openssl rand -base64 32');
  }

  const signInNote = optional('SIGN_IN_NOTE') ?? null;
  if (signInNote && signInNote.length > MAX_SIGN_IN_NOTE) {
    invalid.push(`SIGN_IN_NOTE must be at most ${MAX_SIGN_IN_NOTE} characters, got ${signInNote.length}`);
  }

  let allowedEmails: AccessList | null = null;
  const rawAllowed = optional('ALLOWED_EMAILS');
  if (rawAllowed) {
    const parsed = parseAccessList(rawAllowed);
    if (parsed.invalid.length) invalid.push(`ALLOWED_EMAILS has entries that are neither an email nor @domain: ${parsed.invalid.join(', ')}`);
    allowedEmails = parsed.list;
  }

  const config: Config = {
    port,
    appUrl,
    isProduction: env.NODE_ENV === 'production',
    databaseUrl: required('DATABASE_URL'),
    encryptionKey,
    google: {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
    },
    syncIntervalMinutes: integer('SYNC_INTERVAL_MINUTES', 60, 0, 24 * 60),
    historyDays: integer('HISTORY_DAYS', DEFAULT_HISTORY_DAYS, DASHBOARD_WINDOW_DAYS, 3650),
    allowedEmails,
    demoMode: flag('DEMO_MODE', true),
    signInNote,
  };

  if (missing.length || invalid.length) throw new ConfigError(missing, invalid);
  return config;
}
