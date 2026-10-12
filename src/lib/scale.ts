/**
 * Round axis bounds and evenly spaced ticks covering [lo, hi], in steps of 1, 2, 2.5 or 5 times a
 * power of ten: 11, 12, 13, 14, 15 rather than the 11.7, 12.6, 13.5 a raw data range produces.
 */
export function niceScale(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi - lo < 1e-9) {
    const pad = Math.max(Math.abs(lo) * 0.05, 1);
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw)!;
  const ticks: number[] = [];
  for (let t = Math.floor(lo / step) * step; t <= Math.ceil(hi / step) * step + step / 2; t += step) {
    ticks.push(Number(t.toFixed(10)));
  }
  return ticks;
}
