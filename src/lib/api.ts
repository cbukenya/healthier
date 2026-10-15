import type { ApiErrorBody } from '../types/api';

/** Thin JSON client for the server's API. The session cookie rides along automatically. */

export class ApiError extends Error {
  /**
   * `detail` is the server's own word on it (its message, else its error code), shown as it is;
   * absent when it sent none, and the status is all there is to say.
   */
  constructor(readonly status: number, readonly code: string, readonly detail?: string) {
    super(detail ?? code);
    // i18n-ignore: the error class's name, for developers
    this.name = 'ApiError';
  }

  /** The user must sign in again: no session, or Google access lost. */
  get needsSignIn(): boolean {
    return this.status === 401 || this.code === 'reconnect_required';
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    signal: init.signal,
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body as Partial<ApiErrorBody>;
    throw new ApiError(res.status, err.error ?? `http_${res.status}`, err.message ?? err.error);
  }
  return body as T;
}
