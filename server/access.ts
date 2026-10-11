/**
 * Who may sign up.
 *
 * Signing in with Google creates the account, so on an instance reachable from
 * the internet this list decides who can join. Unset, anyone who can complete
 * Google's consent screen may sign in — which, while the OAuth app is in
 * "Testing", is only its test users.
 */

export interface AccessList {
  emails: Set<string>;
  /** Lowercased domains, without the leading "@". */
  domains: Set<string>;
}

/**
 * Parse ALLOWED_EMAILS: comma- or space-separated addresses, and `@domain`
 * entries that admit a whole domain. Returns the entries it couldn't read.
 */
export function parseAccessList(raw: string): { list: AccessList; invalid: string[] } {
  const list: AccessList = { emails: new Set(), domains: new Set() };
  const invalid: string[] = [];
  for (const entry of raw.split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)) {
    if (/^@[^@\s]+\.[^@\s]+$/.test(entry)) list.domains.add(entry.slice(1));
    else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry)) list.emails.add(entry);
    else invalid.push(entry);
  }
  return { list, invalid };
}

/** Only a Google-verified address counts; with no list, everyone is allowed. */
export function isAllowed(list: AccessList | null, email: string | null | undefined, verified = true): boolean {
  if (!list) return true;
  if (!email || !verified) return false;
  const address = email.toLowerCase();
  return list.emails.has(address) || list.domains.has(address.slice(address.lastIndexOf('@') + 1));
}
