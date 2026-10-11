import type { ApiErrorBody } from '../types/api';

/** Thin JSON client for the server's API. The session cookie rides along automatically. */

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
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
    throw new ApiError(res.status, err.error ?? `http_${res.status}`, err.message ?? err.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}
