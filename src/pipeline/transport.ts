import { addDays, daysBetween, ghDateFromCivil, type CivilDate } from '../lib/date';

/**
 * Transport.
 *
 * Deliberately the only file that knows about HTTP. It takes an injected `fetch`,
 * which means the whole pipeline above it runs unchanged in three places:
 * the browser (today), a Node server (when tokens move to httpOnly cookies), and
 * a test harness with fixtures and no network at all.
 *
 * What it handles that the previous build didn't:
 *   - **Pagination.** `nextPageToken` was ignored, so only the newest page of any
 *     history was ever seen. Lists now page until they pass the requested date.
 *   - **Retries.** No backoff at all, while the UI re-fetched 22 dataTypes every
 *     60 seconds. That's ~44 requests/minute per open tab, straight into 429s.
 *   - **Concurrency.** `Promise.allSettled` over every dataType fired all requests
 *     at once. Now capped, so a cold sync degrades gracefully instead of
 *     rate-limiting itself.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TransportOptions {
  token: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** Parallel in-flight requests. Google tolerates a handful; 4 is comfortable. */
  concurrency?: number;
  maxRetries?: number;
  /** Called on every completed request, for the Data tab's request counter. */
  onRequest?: (info: { dataType: string; status: number; ms: number; attempt: number }) => void;
  signal?: AbortSignal;
}

/**
 * Why a request failed. Google's reply, or the network's message, keeps its own words; when there
 * were none, a code says what happened, and the app puts it into words.
 */
export type FetchError = { text: string } | { code: 'http'; status: number } | { code: 'network' };

export interface ApiResult<T = any> {
  nextPageToken?: string;
  /** Rollups only: which date chunks succeeded, so partial results can be stored precisely. */
  chunks?: { start: CivilDate; end: CivilDate; ok: boolean }[];
  ok: boolean;
  status: number;
  body?: T;
  error?: FetchError;
  requests: number;
  pages: number;
  truncated: boolean;
  ms: number;
}

const BASE = 'https://health.googleapis.com/v4/users/me';

/** dailyRollUp rejects ranges longer than this. */
export const MAX_ROLLUP_WINDOW_DAYS = 14;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal promise pool — no dependency, preserves input order. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

export class HealthTransport {
  private token: string;
  private fetchImpl: FetchLike;
  private baseUrl: string;
  readonly concurrency: number;
  private maxRetries: number;
  private onRequest?: TransportOptions['onRequest'];
  private signal?: AbortSignal;
  /** Total requests spent this sync, surfaced in the UI. */
  requestCount = 0;

  constructor(opts: TransportOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.baseUrl = opts.baseUrl ?? BASE;
    this.concurrency = opts.concurrency ?? 4;
    this.maxRetries = opts.maxRetries ?? 3;
    this.onRequest = opts.onRequest;
    this.signal = opts.signal;
  }

  /** One request, with backoff on 429 and 5xx. 4xx fails fast — retrying won't help. */
  private async request(dataType: string, url: string, init?: RequestInit): Promise<{
    res: Response | null;
    body: any;
    attempts: number;
    error?: FetchError;
  }> {
    let attempt = 0;
    let lastError: FetchError | undefined;
    while (attempt <= this.maxRetries) {
      attempt++;
      const t0 = Date.now();
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          signal: this.signal,
          headers: {
            // i18n-ignore: an HTTP auth scheme, sent to Google and never shown
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
          },
        });
        this.requestCount++;
        this.onRequest?.({ dataType, status: res.status, ms: Date.now() - t0, attempt });

        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          return { res, body, attempts: attempt };
        }

        const retryable = res.status === 429 || res.status >= 500;
        const text = await res.text().catch(() => '');
        lastError = text ? { text } : { code: 'http', status: res.status };
        if (!retryable || attempt > this.maxRetries) {
          return { res, body: null, attempts: attempt, error: lastError };
        }
        // Honour Retry-After when the server sends it, else exponential + jitter.
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2 ** attempt * 250 + Math.random() * 250;
        await sleep(wait);
      } catch (err: any) {
        this.requestCount++;
        // Never shown: an aborted sync's results are thrown away.
        if (err?.name === 'AbortError') return { res: null, body: null, attempts: attempt, error: { text: 'aborted' } };
        lastError = err?.message ? { text: err.message } : { code: 'network' };
        if (attempt > this.maxRetries) break;
        await sleep(2 ** attempt * 250);
      }
    }
    return { res: null, body: null, attempts: attempt, error: lastError };
  }

  /** The account's age in years from Google Health's profile; null when it has none, undefined when the request failed. */
  async profileAge(): Promise<number | null | undefined> {
    const { body, error } = await this.request('profile', `${this.baseUrl}/profile`);
    if (error) return undefined;
    return typeof body?.age === 'number' && Number.isFinite(body.age) ? body.age : null;
  }

  /**
   * POST :dailyRollUp across a civil window, split into ≤14-day chunks and
   * re-joined. Chunk failures are partial, not fatal: 40 good days beat an error,
   * but the result still carries the error and says which chunks failed.
   */
  async rollup(dataType: string, from: CivilDate, to: CivilDate): Promise<ApiResult> {
    const t0 = Date.now();
    const chunks = splitWindow(from, to, MAX_ROLLUP_WINDOW_DAYS);
    const points: any[] = [];
    let requests = 0;
    let firstError: FetchError | undefined;
    let status = 200;

    const results = await pool(chunks, this.concurrency, async (chunk) => {
      const body = {
        range: {
          // The API's end bound is exclusive, so ask for the day after `to`.
          start: { date: ghDateFromCivil(chunk.start) },
          end: { date: ghDateFromCivil(addDays(chunk.end, 1)) },
        },
        windowSizeDays: 1,
      };
      return this.request(dataType, `${this.baseUrl}/dataTypes/${dataType}/dataPoints:dailyRollUp`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    });

    for (const r of results) {
      requests += r.attempts;
      if (r.error) {
        firstError ??= r.error;
        status = r.res?.status ?? 500;
        continue;
      }
      const arr = r.body?.rollupDataPoints;
      if (Array.isArray(arr)) points.push(...arr);
    }

    return {
      ok: !firstError,
      status,
      body: { rollupDataPoints: points },
      error: firstError,
      requests,
      pages: chunks.length,
      truncated: false,
      ms: Date.now() - t0,
      chunks: chunks.map((c, i) => ({ start: c.start, end: c.end, ok: !results[i].error })),
    };
  }

  /**
   * POST :rollUp — fixed windows over physical (UTC) time, e.g. one-minute
   * heart-rate buckets. Pages share the request body, so they run in sequence.
   */
  async rollUpWindows(
    dataType: string,
    range: { startTime: string; endTime: string },
    windowSize: string,
    opts: { pageSize?: number; maxPages?: number } = {},
  ): Promise<ApiResult> {
    const t0 = Date.now();
    const maxPages = opts.maxPages ?? 5;
    const points: any[] = [];
    let requests = 0;
    let pages = 0;
    let token: string | undefined;
    let error: FetchError | undefined;
    let status = 200;

    do {
      const r = await this.request(dataType, `${this.baseUrl}/dataTypes/${dataType}/dataPoints:rollUp`, {
        method: 'POST',
        body: JSON.stringify({ range, windowSize, pageSize: opts.pageSize ?? 10000, ...(token ? { pageToken: token } : {}) }),
      });
      requests += r.attempts;
      pages++;
      if (r.error) {
        error = r.error;
        status = r.res?.status ?? 500;
        break;
      }
      const arr = r.body?.rollupDataPoints;
      if (Array.isArray(arr)) points.push(...arr);
      token = r.body?.nextPageToken || undefined;
    } while (token && pages < maxPages);

    return {
      ok: !error,
      status,
      body: { rollupDataPoints: points },
      error,
      requests,
      pages,
      truncated: !!token,
      ms: Date.now() - t0,
    };
  }

  /**
   * GET dataPoints, newest first, following `nextPageToken` until `stopWhen`
   * says a page has reached far enough back. `maxPages` is a hard stop;
   * `truncated` tells the UI the series is incomplete rather than letting a
   * partial page masquerade as the whole history.
   */
  async list(
    dataType: string,
    opts: { pageSize?: number; maxPages?: number; pageToken?: string; stopWhen?: (page: any[]) => boolean } = {},
  ): Promise<ApiResult> {
    const t0 = Date.now();
    const pageSize = opts.pageSize ?? 100;
    const maxPages = opts.maxPages ?? 1;
    const points: any[] = [];
    let requests = 0;
    let pages = 0;
    let token: string | undefined = opts.pageToken;
    let error: FetchError | undefined;
    let status = 200;
    let reachedEnough = false;

    do {
      const params = new URLSearchParams({ pageSize: String(pageSize) });
      if (token) params.set('pageToken', token);
      const r = await this.request(
        dataType,
        `${this.baseUrl}/dataTypes/${dataType}/dataPoints?${params}`,
      );
      requests += r.attempts;
      pages++;

      if (r.error) {
        error = r.error;
        status = r.res?.status ?? 500;
        break;
      }
      const arr = Array.isArray(r.body?.dataPoints) ? r.body.dataPoints : [];
      points.push(...arr);
      token = r.body?.nextPageToken || undefined;
      reachedEnough = !!opts.stopWhen?.(arr);
    } while (token && !reachedEnough && pages < maxPages);

    return {
      ok: !error,
      status: error ? status : 200,
      body: { dataPoints: points },
      error,
      requests,
      pages,
      truncated: !!token && !reachedEnough,
      nextPageToken: token,
      ms: Date.now() - t0,
    };
  }
}

export interface WindowChunk {
  start: CivilDate;
  end: CivilDate;
}

/** Split an inclusive civil window into chunks of at most `size` days. */
export function splitWindow(from: CivilDate, to: CivilDate, size: number): WindowChunk[] {
  const total = daysBetween(from, to) + 1;
  if (total <= 0) return [];
  const chunks: WindowChunk[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDays(cursor, size - 1);
    // ISO dates sort lexicographically, so this is a plain clamp to the window end.
    chunks.push({ start: cursor, end: end > to ? to : end });
    cursor = addDays(cursor, size);
  }
  return chunks;
}
