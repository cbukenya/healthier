import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Secrets at rest.
 *
 * A Google refresh token grants ongoing read access to someone's health data, so
 * it is encrypted with AES-256-GCM before it reaches the database. A leaked dump
 * or backup is useless without ENCRYPTION_KEY, and GCM's auth tag means a
 * tampered row fails to decrypt instead of yielding garbage.
 *
 * Layout: 12-byte IV | 16-byte auth tag | ciphertext.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(key: Buffer, blob: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_BYTES));
  decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

/** URL-safe random token, for session ids and OAuth state. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Session ids are stored hashed, so a leaked sessions table can't be replayed. */
export const sha256 = (value: string) => createHash('sha256').update(value).digest();
