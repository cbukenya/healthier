/**
 * Google Health is inconsistent about number encoding. Within a single response
 * you get `countSum: "7229"` (int64 as string), `kcalSum: 521.318` (double),
 * `beatsPerMinute: "63"` (string) and — on days the watch hasn't calibrated —
 * `baselineTemperatureCelsius: "NaN"` (the literal string).
 *
 * `parseInt("NaN")` is NaN, `Number(null)` is 0. The old pipeline used both, so
 * un-recorded days became zeros and NaN leaked into averages. These helpers
 * return `null` for anything that isn't a usable finite number, and callers must
 * handle null rather than defaulting.
 */

/** Any scalar → finite number, or null. Never returns NaN, never invents 0. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t || t === 'NaN' || t === 'Infinity' || t === '-Infinity') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Integer variant, rounded. */
export function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

/** Sum of several optional numbers; null only if every input is null. */
export function sumOf(...vals: unknown[]): number | null {
  let total = 0;
  let seen = false;
  for (const v of vals) {
    const n = num(v);
    if (n !== null) {
      total += n;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Round to `dp` decimals, preserving null. */
export function round(v: number | null, dp = 1): number | null {
  if (v === null) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Treat a sentinel value as missing. Google reports vo2Max: 0 before calibration. */
export function nullIf(v: number | null, sentinel: number): number | null {
  return v === null || v === sentinel ? null : v;
}
