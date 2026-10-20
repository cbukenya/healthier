import React, { useEffect, useId, useMemo, useState } from 'react';
import { Activity, AppWindow, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Circle, HeartPulse, PencilLine, Smartphone, Watch, Weight } from 'lucide-react';
import { hasMessage, t, type MessageKey } from '../i18n';
import { formatDayMonthLong, formatList } from '../i18n/format';
import { streamName } from '../i18n/streams';
import { api } from '../lib/api';
import { addDays } from '../lib/date';
import { DEFAULT_SOURCE_PREFS, READING_STREAMS, sourceRanking, type SourcePrefs, type SourceSeen, type TotalsFamily } from '../pipeline/sources';
import type { SyncResult } from '../pipeline/sync';
import type { SourceSummary, SourcesResponse } from '../types/api';
import { Switch } from '../ui/Switch';
import { SectionCard } from './DataCards';
import { SECTION_TONE } from './sectionTones';

/** Devices and sources in its own colour, its icon's in the Settings page's list. */
const TONE = SECTION_TONE.devices;

/**
 * Devices and sources (pipeline/sources.ts): which of the person's devices and apps each reading
 * comes from, in what order they're tried, which are switched off, and which kinds of source
 * Google counts in daily totals. Advanced sets a first choice per reading.
 *
 * A choice of device takes effect at once: the server picks each day's reading when it's read,
 * from every source's reading it keeps. Only a new choice for daily totals is fetched again.
 */

const TOTALS: TotalsFamily[] = ['all', 'google', 'worn'];
const TOTALS_WORDS = {
  all: { name: 'data.sources.totals.all.name', note: 'data.sources.totals.all.note' },
  google: { name: 'data.sources.totals.google.name', note: 'data.sources.totals.google.note' },
  worn: { name: 'data.sources.totals.worn.name', note: 'data.sources.totals.worn.note' },
} as const satisfies Record<TotalsFamily, { name: MessageKey; note: MessageKey }>;

/** A source older than this has its last reading named. */
const NAME_LAST_AFTER_DAYS = 7;

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  WATCH: Watch, RING: Circle, PHONE: Smartphone, SCALE: Weight, FITNESS_BAND: Activity, CHEST_STRAP: HeartPulse,
};
function iconFor(s: SourceSummary) {
  if (s.method === 'MANUAL') return PencilLine;
  if (s.formFactor && ICONS[s.formFactor]) return ICONS[s.formFactor];
  return s.app ? AppWindow : Activity;
}

/** The days a source reported its main reading in the window, and the days that reading was used. */
function main(s: SourceSummary) {
  return s.readings.reduce((best, r) => (r.offered > best.offered ? r : best), { dataType: '', offered: 0, used: 0 });
}

/** The person's sources in the order tried, as the server ranked them. */
function ordered(view: SourcesResponse): SourceSummary[] {
  const byId = new Map(view.sources.map((s) => [s.id, s]));
  return view.order.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
}

/** In demo mode: the demo's sources, from the days it holds, with nothing to choose. */
function demoView(data: SyncResult): SourcesResponse {
  const byId = new Map<string, SourceSummary>();
  for (const ref of data.meta.sources) {
    byId.set(ref.id, { id: ref.id, label: ref.label, platform: ref.platform, method: ref.method, formFactor: ref.formFactor, app: ref.app, lastSeen: null, readings: [] });
  }
  const seen = new Map<string, Map<string, SourceSeen>>();
  for (const d of data.days) {
    for (const [dataType, id] of Object.entries(d.sourceByType)) {
      const s = byId.get(id);
      if (!s) continue;
      if (!s.lastSeen || d.date > s.lastSeen) s.lastSeen = d.date;
      let r = s.readings.find((x) => x.dataType === dataType);
      if (!r) s.readings.push((r = { dataType, offered: 0, used: 0 }));
      r.offered++;
      r.used++;
      const forType = seen.get(dataType) ?? new Map<string, SourceSeen>();
      seen.set(dataType, forType);
      const x = forType.get(id);
      if (!x) forType.set(id, { latest: d.date, days: 1 });
      else {
        x.days++;
        if (d.date > x.latest) x.latest = d.date;
      }
    }
  }
  const prefs = data.profile?.sources ?? DEFAULT_SOURCE_PREFS;
  const sources = [...byId.values()].filter((s) => s.readings.length);
  return { prefs, order: sourceRanking(seen, prefs), sources, windowDays: data.days.length, refetching: false };
}

/** The person's devices and apps, and the means to choose between them: shared by the Settings page's list and the section. */
export interface Sources {
  /** As the server describes them, or the demo's own; null until they've loaded. */
  view: SourcesResponse | null;
  /** Keeps a new choice. False when it couldn't be saved, and the old one stands. */
  save: (next: SourcePrefs) => Promise<boolean>;
  /** Daily totals are being fetched again, after a new choice for them. */
  refetching: boolean;
}

export function useSources(data: SyncResult, live: boolean, onChanged: (refetching: boolean) => void): Sources {
  const [loaded, setLoaded] = useState<SourcesResponse | null>(null);
  const [refetching, setRefetching] = useState(false);

  // The counts change as the days do: read them again with each new dataset.
  useEffect(() => {
    if (!live) return;
    let current = true;
    api<SourcesResponse>('/api/sources')
      .then((res) => {
        if (current) setLoaded(res);
      })
      .catch((err) => console.error('Failed to load devices and sources:', err));
    return () => {
      current = false;
    };
  }, [live, data]);
  useEffect(() => {
    if (refetching) setRefetching(false);
    // A new dataset after a refetch means it's done.
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const demo = useMemo(() => (live ? null : demoView(data)), [live, data]);
  const save = async (next: SourcePrefs) => {
    if (!live || !loaded) return false;
    const before = loaded;
    setLoaded({ ...loaded, prefs: next });
    try {
      const res = await api<SourcesResponse>('/api/sources', { method: 'PUT', body: { prefs: next } });
      setLoaded(res);
      if (res.refetching) setRefetching(true);
      onChanged(res.refetching);
      return true;
    } catch (err) {
      console.error('Failed to save devices and sources:', err);
      setLoaded(before);
      return false;
    }
  };
  return { view: live ? loaded : demo, save, refetching };
}

/** What the Settings page's list says of them: "Google Fitbit Air first, then Smart scale". */
export function sourcesSummary(view: SourcesResponse): string {
  const off = new Set(view.prefs.off);
  const used = ordered(view).filter((s) => !off.has(s.id));
  if (!used.length) return t('data.overview.summaries.devicesNone');
  if (used.length === 1) return used[0].label;
  return t('data.overview.summaries.devices', { first: used[0].label, rest: formatList(used.slice(1).map((s) => s.label)) });
}

export function SourcesCard({ data, live, sources }: {
  data: SyncResult;
  /** False in demo mode, where the demo's sources are shown and nothing can be chosen. */
  live: boolean;
  sources: Sources;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState<TotalsFamily | null>(null);
  const { view, refetching } = sources;

  const rows = useMemo(() => (view ? ordered(view) : []), [view]);
  if (!view) {
    return (
      <SectionCard title={t('data.sources.title')} hint={t('data.sources.hint')}>
        <p role="status" className="px-5 pb-5 text-caption text-zinc-500 animate-pulse">{t('data.sources.loading')}</p>
      </SectionCard>
    );
  }
  const prefs = view.prefs;
  const off = new Set(prefs.off);
  const today = data.days.at(-1)?.date ?? null;

  const save = async (next: SourcePrefs) => {
    setFailed(false);
    if (!(await sources.save(next))) setFailed(true);
  };
  const move = (i: number, by: number) => {
    const ids = rows.map((s) => s.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void save({ ...prefs, order: ids });
  };
  const toggle = (id: string) => void save({ ...prefs, off: off.has(id) ? prefs.off.filter((x) => x !== id) : [...prefs.off, id] });

  return (
    <SectionCard
      title={t('data.sources.title')}
      hint={t('data.sources.hint')}
      right={rows.length > 1 && (
        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          className="min-h-10 inline-flex items-center gap-1.5 px-3 rounded-lg border border-zinc-700 text-detail font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          {advanced && <ChevronLeft size={14} aria-hidden />}
          {t(advanced ? 'data.sources.simple' : 'data.sources.advanced')}
          {!advanced && <ChevronRight size={14} aria-hidden />}
        </button>
      )}
    >
      <div className="@container px-5 pb-4">
        {advanced ? (
          <PerReading rows={rows} prefs={prefs} live={live} onPick={(next) => void save(next)} />
        ) : (
          rows.length > 0 && (
            <>
              <div className="pb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h4 className="text-eyebrow uppercase text-zinc-500">{t('data.sources.readings.title')}</h4>
                <p className="text-caption leading-relaxed text-zinc-500 max-w-[64ch]">{t('data.sources.readings.hint')}</p>
              </div>
              {rows.map((s, i) => (
                <SourceRow
                  key={s.id}
                  source={s}
                  rank={off.has(s.id) ? null : rows.slice(0, i + 1).filter((x) => !off.has(x.id)).length}
                  on={!off.has(s.id)}
                  windowDays={view.windowDays}
                  today={today}
                  live={live}
                  first={i === 0}
                  last={i === rows.length - 1}
                  onUp={() => move(i, -1)}
                  onDown={() => move(i, 1)}
                  onToggle={() => toggle(s.id)}
                />
              ))}
            </>
          )
        )}

        <div className="mt-2 pt-3 border-t border-zinc-800">
          <div className="pb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h4 id="sources-totals" className="text-eyebrow uppercase text-zinc-500">{t('data.sources.totals.title')}</h4>
            <p className="text-caption leading-relaxed text-zinc-500 max-w-[64ch]">{t('data.sources.totals.hint')}</p>
          </div>
          <div role="radiogroup" aria-labelledby="sources-totals" className="grid grid-cols-1 @2xl:grid-cols-3 gap-2">
            {TOTALS.map((f) => {
              const on = (asking ?? prefs.totals) === f;
              return (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!live || refetching}
                  onClick={() => setAsking(f === prefs.totals ? null : f)}
                  className={`min-h-11 p-3 text-left rounded-xl border transition-colors disabled:cursor-default ${on ? TONE.choice : 'border-zinc-800 hover:bg-zinc-800/50'}`}
                >
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className={`size-3.5 shrink-0 rounded-full ${on ? `border-4 ${TONE.mark}` : 'border-2 border-zinc-600'}`} />
                    <span className="text-body-sm text-zinc-100">{t(TOTALS_WORDS[f].name)}</span>
                  </span>
                  <span className="block mt-1 pl-5.5 text-caption leading-relaxed text-zinc-400">{t(TOTALS_WORDS[f].note)}</span>
                </button>
              );
            })}
          </div>
          {asking && (
            <div role="alertdialog" aria-labelledby="sources-confirm" className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p id="sources-confirm" className="flex-[1_1_20rem] text-caption leading-relaxed text-zinc-300">{t('data.sources.totals.confirm')}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setAsking(null)} className="min-h-10 px-3.5 rounded-lg border border-zinc-700 text-detail font-medium text-zinc-300 hover:bg-zinc-800">
                  {t('data.sources.totals.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = asking;
                    setAsking(null);
                    void save({ ...prefs, totals: next });
                  }}
                  className="min-h-10 px-4 rounded-lg bg-zinc-50 text-zinc-950 text-detail font-semibold hover:bg-white"
                >
                  {t('data.sources.totals.apply')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-3 pt-3 border-t border-zinc-800 text-caption leading-relaxed text-zinc-500">
          {refetching ? <p role="status">{t('data.sources.totals.refetching')}</p> : <p>{t(live ? 'data.sources.footer' : 'data.sources.demo')}</p>}
          {failed && <p role="alert" className="mt-1 text-rose-400">{t('data.sources.failed')}</p>}
        </div>
      </div>
    </SectionCard>
  );
}

/** One device or app: its order, what it reports, how its readings are used, and its switch. */
function SourceRow({ source: s, rank, on, windowDays, today, live, first, last, onUp, onDown, onToggle }: {
  source: SourceSummary;
  rank: number | null;
  on: boolean;
  windowDays: number;
  today: string | null;
  live: boolean;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onToggle: () => void;
}) {
  const id = useId();
  const Icon = iconFor(s);
  const formFactor = s.formFactor && hasMessage(`data.streams.formFactors.${s.formFactor}`) ? t(`data.streams.formFactors.${s.formFactor}` as MessageKey) : null;
  const what = s.method === 'MANUAL' ? t('data.sources.kind.manual') : formFactor ?? (s.app ? t('data.sources.kind.app') : null);
  const platform = t('data.sources.kind.platform', { platform: s.platform });
  const stale = today && s.lastSeen && s.lastSeen < addDays(today, -NAME_LAST_AFTER_DAYS) ? t('data.sources.kind.lastReading', { date: formatDayMonthLong(s.lastSeen) }) : null;
  const kind = [what, platform, stale].filter(Boolean).join(' · ');
  const inWindow = s.readings.filter((r) => r.offered > 0);
  const supplies = inWindow.length
    ? formatList(inWindow.map((r) => streamName(r.dataType, r.dataType)))
    : t('data.sources.supplies.none', { days: windowDays });
  const m = main(s);
  const status = !on
    ? t('data.sources.status.off')
    : m.offered === 0
      ? t('data.sources.status.older')
      : m.used === m.offered
        ? t('data.sources.status.all', { count: m.offered })
        : m.used === 0
          ? t('data.sources.status.none', { count: m.offered })
          : t('data.sources.status.some', { used: m.used, count: m.offered });
  const arrow = 'size-10 shrink-0 flex items-center justify-center rounded-full border border-zinc-700 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-default';
  return (
    <div className="py-3 border-t border-zinc-800/60 flex flex-wrap items-start gap-x-3 gap-y-2">
      <span aria-hidden="true" className={`hidden sm:flex size-6 mt-1 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-caption font-semibold tabular-nums ${on ? 'text-zinc-200' : 'text-zinc-600'}`}>
        {rank ?? '–'}
      </span>
      <span aria-hidden="true" className={`size-8 shrink-0 rounded-lg flex items-center justify-center ${on ? TONE.tile : 'bg-zinc-800/80 text-zinc-600'}`}>
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-[1_1_14rem]">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span id={id} className={`text-body ${on ? 'text-zinc-200' : 'text-zinc-400'}`}>{s.label}</span>
          {kind && <span className="text-caption text-zinc-500">{kind}</span>}
        </div>
        <p className="mt-0.5 text-caption leading-relaxed text-zinc-400">{supplies}</p>
        <p className={`mt-0.5 text-caption leading-relaxed ${on ? 'text-zinc-500' : 'text-rose-300/80'}`}>{status}</p>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <button type="button" aria-label={t('data.sources.move.up', { name: s.label })} disabled={!live || first} onClick={onUp} className={arrow}>
          <ArrowUp size={16} aria-hidden />
        </button>
        <button type="button" aria-label={t('data.sources.move.down', { name: s.label })} disabled={!live || last} onClick={onDown} className={arrow}>
          <ArrowDown size={16} aria-hidden />
        </button>
        <Switch on={on} onToggle={onToggle} tone={TONE} labelledBy={id} disabled={!live} className="ml-2" />
      </div>
    </div>
  );
}

/**
 * Advanced: a first choice for each reading. Every source shows as a column, a switched-off one
 * greyed out; a reading a source doesn't report has no choice there.
 */
function PerReading({ rows, prefs, live, onPick }: {
  rows: SourceSummary[];
  prefs: SourcePrefs;
  live: boolean;
  onPick: (next: SourcePrefs) => void;
}) {
  const off = new Set(prefs.off);
  const reports = (s: SourceSummary, dataType: string) => s.readings.some((r) => r.dataType === dataType);
  const readings = READING_STREAMS.filter((dt) => rows.some((s) => reports(s, dt)));
  /** The source a reading is taken from first: its own first choice, else the order's first that reports it. */
  const firstFor = (dataType: string) => {
    const own = prefs.perReading[dataType];
    if (own && !off.has(own) && rows.some((s) => s.id === own && reports(s, dataType))) return own;
    return rows.find((s) => !off.has(s.id) && reports(s, dataType))?.id ?? null;
  };
  const pick = (dataType: string, id: string) => {
    const perReading = { ...prefs.perReading };
    delete perReading[dataType];
    const byOrder = rows.find((s) => !off.has(s.id) && reports(s, dataType))?.id;
    if (id !== byOrder) perReading[dataType] = id;
    onPick({ ...prefs, perReading });
  };
  return (
    <>
      <p className="pb-2 text-caption leading-relaxed text-zinc-500">{t('data.sources.grid.hint')}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse">
          <thead>
            <tr>
              <th scope="col" className="py-2 pr-2 text-left text-eyebrow uppercase text-zinc-500 font-normal">{t('data.sources.grid.reading')}</th>
              {rows.map((s) => (
                <th key={s.id} scope="col" className={`py-2 px-2 text-center text-detail font-medium leading-snug ${off.has(s.id) ? 'text-zinc-600' : 'text-zinc-300'}`}>
                  {s.label}
                  {off.has(s.id) && <span className="block text-note font-normal text-zinc-600">{t('data.sources.grid.off')}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {readings.map((dt) => {
              const first = firstFor(dt);
              const name = streamName(dt, dt);
              return (
                <tr key={dt} className="border-t border-zinc-800/60">
                  <th scope="row" className="py-1.5 pr-2 text-left text-body-sm font-normal text-zinc-200 whitespace-nowrap">{name}</th>
                  {rows.map((s) => {
                    const offered = reports(s, dt);
                    const isOff = off.has(s.id);
                    const on = first === s.id;
                    return (
                      <td key={s.id} className="px-2 text-center">
                        {offered ? (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={on}
                            aria-label={t('data.sources.grid.pick', { reading: name, name: s.label })}
                            disabled={!live || isOff}
                            onClick={() => pick(dt, s.id)}
                            className="size-11 inline-flex items-center justify-center disabled:cursor-default"
                          >
                            <span aria-hidden="true" className={`size-4.5 rounded-full ${isOff ? 'border-2 border-zinc-800' : on ? `border-[5px] ${TONE.mark}` : 'border-2 border-zinc-600'}`} />
                          </button>
                        ) : (
                          <span className="text-caption text-zinc-700">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="border-t border-zinc-800/60">
              <th scope="row" className="py-2.5 pr-2 text-left text-body-sm font-normal text-zinc-400 whitespace-nowrap">{t('data.sources.grid.minute')}</th>
              <td colSpan={rows.length} className="py-2.5 px-2 text-caption leading-relaxed text-zinc-500">{t('data.sources.grid.minuteNote')}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
