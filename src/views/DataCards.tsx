import React, { useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, Lock, Minus, Plus, RefreshCw } from 'lucide-react';
import { daysBetween, type CivilDate } from '../lib/date';
import { formatCivil, formatCivilYear, formatFixed, formatInteger, formatList, formatMonthYear } from '../i18n/format';
import { hasMessage, t, type MessageKey } from '../i18n';
import { rich } from '../i18n/react';
import { streamName } from '../i18n/streams';
import { BASELINE_DAYS, NEED_ESTIMATE } from '../pipeline/derive';
import { REFETCH_DAYS } from '../pipeline/incremental';
import { DEFAULT_GOALS, GOAL_LIMITS, WHO_WEEK, fitGoal, sameGoals, type GoalLimit, type Goals } from '../pipeline/goals';
import { parseSource } from '../pipeline/normalize';
import { INTRADAY_HEART_RATE, STREAMS, STREAMS_BY_TYPE } from '../pipeline/registry';
import type { SyncResult } from '../pipeline/sync';
import type { HistoryInfo } from '../types/api';
import type { MetricDomain, SourceRef, StreamReport } from '../types/health';
import { useGoalsControl } from '../hooks/useGoals';
import { SPANS, spanLabel } from '../ui/span';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { Card, CardHead, DURATION_UNIT, fmtDuration, withUnits } from '../ui/primitives';

// ─────────────────────────────────────────────────────────── sync status

/** "Just now", "12 minutes ago", "3 hours ago", "2 days ago". */
function ago(then: number, now: number): string {
  const min = Math.floor((now - then) / 60_000);
  if (min < 1) return t('data.sync.lastSynced.justNow');
  if (min < 60) return t('data.sync.lastSynced.minutes', { count: min });
  const h = Math.floor(min / 60);
  return h < 24 ? t('data.sync.lastSynced.hours', { count: h }) : t('data.sync.lastSynced.days', { count: Math.floor(h / 24) });
}

/**
 * When the data last came in, what the dashboard covers and how far back the
 * history goes, with the two things you can do about it. Small on purpose: the
 * Goals card sits under it.
 */
export function SyncStatus({
  data,
  history,
  onFullSync,
  onDisconnect,
}: {
  data: SyncResult;
  history: HistoryInfo | null;
  onFullSync: () => void;
  /** Absent in demo mode, where there's nothing stored to delete. */
  onDisconnect?: () => void;
}) {
  // A minute's tick keeps "12 minutes ago" true while the page stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { meta } = data;
  const synced = Date.parse(meta.finishedAt);
  const known = !Number.isNaN(synced);
  // The app syncs whenever it opens on data older than 15 minutes, so a day-old sync means it couldn't.
  const stale = known && now - synced > 24 * 3_600_000;
  const took = meta.ms < 1000
    ? t('data.sync.took.milliseconds', { ms: meta.ms })
    : t('data.sync.took.seconds', { seconds: formatFixed(meta.ms / 1000, 1) });

  return (
    <Card>
      <CardHead
        title={t('data.sync.title')}
        right={
          <button
            onClick={onFullSync}
            title={t('data.sync.fullSyncHint')}
            className="-my-2.5 md:-my-1 min-h-11 md:min-h-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors text-caption font-medium text-zinc-200"
          >
            <RefreshCw size={12} aria-hidden="true" /> {t('data.sync.fullSync')}
          </button>
        }
      />
      <dl className="px-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-caption">
        <dt className="text-zinc-500">{t('data.sync.lastSynced.label')}</dt>
        <dd className="text-right text-zinc-200">
          {known ? (
            <>
              <span aria-hidden="true" className={`inline-block w-1.5 h-1.5 mr-1.5 rounded-full align-[1px] ${stale ? 'bg-amber-400' : 'bg-emerald-400'}`} />
              {ago(synced, now)}
            </>
          ) : (
            '—'
          )}
        </dd>
        <dt className="text-zinc-500">{t('data.sync.window.label')}</dt>
        <dd className="text-right text-zinc-200 tabular-nums">
          {t('data.sync.window.value', { from: formatCivil(meta.from), to: formatCivil(meta.to), count: data.days.length })}
        </dd>
        {history?.from && (
          <>
            <dt className="text-zinc-500">{t('data.sync.history.label')}</dt>
            <dd className="text-right text-zinc-200">
              {t('data.sync.history.from', { date: formatCivilYear(history.from) })} ·{' '}
              {history.backfilling ? (
                <span className="text-amber-400">{t('data.sync.history.importing')}</span>
              ) : history.complete ? (
                <span className="text-emerald-400">{t('data.sync.history.complete')}</span>
              ) : (
                <span className="text-amber-400" title={t('data.sync.history.incompleteHint')}>{t('data.sync.history.incomplete')}</span>
              )}
            </dd>
          </>
        )}
      </dl>
      <div className="mt-3 pl-5 pr-2 py-0.5 min-h-10 border-t border-zinc-800/60 flex items-center justify-between gap-3">
        <span className="text-note text-zinc-500 tabular-nums">
          {t('data.sync.lastSync', { count: meta.totalRequests, took })}
        </span>
        {onDisconnect && (
          <button
            onClick={onDisconnect}
            className="min-h-11 md:min-h-9 px-3 rounded-lg text-caption font-medium text-rose-400 hover:bg-rose-500/10 transition-colors"
          >
            {t('data.sync.disconnect')}
          </button>
        )}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────── data facts

/**
 * What anyone needs to know to trust the numbers, in everyday words: no AI,
 * what "usual" means, the span things cover, how missing days are treated and
 * where the data is smoothed. Each figure comes from the constant it describes.
 */
export function DataFacts({ windowDays, windowFrom, historyFrom, className = '' }: {
  windowDays: number;
  /** The window's first day: history older than this reaches the longer views. */
  windowFrom: CivilDate;
  historyFrom: CivilDate | null;
  className?: string;
}) {
  // The words are the app's own: body battery, sleep score, insights, usual, window, history, sync, Today so far, Labs.
  // The span buttons past the window, by their own labels: "90d, 1y and All".
  const longer = SPANS.filter((s) => s.days > windowDays).map((s) => spanLabel(s.id));
  // The month the history goes back to, when it reaches past the window and a longer view shows it.
  const back = historyFrom && historyFrom < windowFrom && longer.length ? formatMonthYear(historyFrom) : null;
  const facts: [id: string, lead: string, text: string][] = [
    ['arithmetic', t('data.facts.arithmetic.lead'), t('data.facts.arithmetic.text')],
    ['usual', t('data.facts.usual.lead'), t('data.facts.usual.text', { days: BASELINE_DAYS })],
    [
      'window',
      t('data.facts.window.lead', { days: windowDays }),
      t('data.facts.window.text', {
        days: windowDays,
        history: back ? 'shown' : 'none',
        views: formatList(longer),
        viewCount: longer.length,
        month: back,
        refetch: REFETCH_DAYS,
      }),
    ],
    ['missing', t('data.facts.missing.lead'), t('data.facts.missing.text')],
    ['minutes', t('data.facts.minutes.lead'), t('data.facts.minutes.text')],
  ];
  return (
    <Card className={className}>
      <CardHead title={t('data.facts.title')} domain="data" />
      <ul className="px-5 pb-2">
        {facts.map(([id, lead, text], i) => (
          <li key={id} className={i ? 'py-3 border-t border-zinc-800/60' : 'pt-1 pb-3'}>
            <div className="text-body-sm font-medium text-zinc-200">{lead}</div>
            <p className="mt-0.5 text-caption leading-relaxed text-zinc-400">{text}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────────── goals

/** "7", "8½": hours from minutes on the hour or half hour. */
const hours = (min: number) => t('data.goals.sleepNeed.hours', { hours: Math.floor(min / 60), half: min % 60 ? 'yes' : 'no' });

/** How many days at a daily brisk goal it takes to reach the WHO's week, if a week is enough. */
function briskNote(perDay: number): string {
  const days = Math.ceil(WHO_WEEK / perDay);
  return days <= 7
    ? t('data.goals.brisk.noteDays', { days, minutes: WHO_WEEK })
    : t('data.goals.brisk.noteEveryDay', { minutes: WHO_WEEK });
}

/**
 * The goals the rings, charts and insights measure against, each on a stepper
 * that stays inside its bounds (GOAL_LIMITS, and why). Sleep need is worked out
 * from your nights until you set it; a step either way takes it over from there.
 */
export function GoalsCard({ autoNeed }: {
  /** The need the app works out from your nights, shown while yours is automatic. */
  autoNeed: number;
}) {
  const { goals, change, failed } = useGoalsControl();
  if (!change) return null;
  const set = (patch: Partial<Goals>) => change({ ...goals, ...patch });
  /** A step down and a step up from a goal's value, each absent at its bound. */
  const stepper = (value: number, limit: GoalLimit, patch: (v: number) => Partial<Goals>) => ({
    less: value > limit.min ? () => set(patch(fitGoal(value - limit.step, limit))) : undefined,
    more: value < limit.max ? () => set(patch(fitGoal(value + limit.step, limit))) : undefined,
  });
  const need = goals.sleepNeed ?? autoNeed;
  const L = GOAL_LIMITS;

  return (
    <Card>
      <CardHead
        title={t('data.goals.title')}
        hint={t('data.goals.hint')}
        right={
          !sameGoals(goals, DEFAULT_GOALS) && (
            <button
              type="button"
              onClick={() => change(DEFAULT_GOALS)}
              className="-my-2.5 md:-my-1.5 -mr-2 min-h-11 md:min-h-0 px-2 md:py-1.5 rounded-lg text-caption font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
            >
              {t('data.goals.reset')}
            </button>
          )
        }
      />
      <div className="px-5 pb-1.5">
        <GoalRow
          label={t('data.goals.steps.label')}
          per={t('data.goals.steps.per')}
          shown={formatInteger(goals.steps)}
          {...stepper(goals.steps, L.steps, (v) => ({ steps: v }))}
          lessLabel={t('data.goals.steps.less')}
          moreLabel={t('data.goals.steps.more')}
          note={t('data.goals.steps.note')}
        />
        <GoalRow
          label={t('data.goals.brisk.label')}
          per={t('data.goals.brisk.per')}
          shown={formatInteger(goals.briskMinutes)}
          {...stepper(goals.briskMinutes, L.briskMinutes, (v) => ({ briskMinutes: v }))}
          lessLabel={t('data.goals.brisk.less')}
          moreLabel={t('data.goals.brisk.more')}
          note={briskNote(goals.briskMinutes)}
        />
        <GoalRow
          label={t('data.goals.sleepNeed.label')}
          per={t('data.goals.sleepNeed.per')}
          badge={goals.sleepNeed === null ? t('data.goals.sleepNeed.auto') : undefined}
          shown={withUnits(fmtDuration(need), DURATION_UNIT)}
          {...stepper(need, L.sleepNeed, (v) => ({ sleepNeed: v }))}
          lessLabel={t('data.goals.sleepNeed.less')}
          moreLabel={t('data.goals.sleepNeed.more')}
          note={
            goals.sleepNeed === null
              ? t('data.goals.sleepNeed.noteAuto', { min: hours(NEED_ESTIMATE.floor), max: hours(NEED_ESTIMATE.ceiling) })
              : rich('data.goals.sleepNeed.noteOwn', {
                  min: hours(L.sleepNeed.min),
                  max: hours(L.sleepNeed.max),
                  button: (words) => (
                    <button
                      type="button"
                      onClick={() => set({ sleepNeed: null })}
                      className="text-zinc-300 underline underline-offset-2 hover:text-zinc-100"
                    >
                      {words}
                    </button>
                  ),
                })
          }
        />
      </div>
      {failed && (
        <p role="alert" className="px-5 pb-4 text-caption text-rose-400">
          {t('data.goals.failed')}
        </p>
      )}
    </Card>
  );
}

/** One goal: its name, a stepper either side of the figure, and a line on what it moves. */
function GoalRow({ label, per, badge, shown, less, more, lessLabel, moreLabel, note }: {
  label: string;
  per: string;
  badge?: string;
  shown: React.ReactNode;
  /** Absent at the bound, where the button is disabled. */
  less?: () => void;
  more?: () => void;
  lessLabel: string;
  moreLabel: string;
  note: React.ReactNode;
}) {
  const id = useId();
  const button = 'size-10 shrink-0 flex items-center justify-center rounded-full border border-zinc-700 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-default';
  return (
    <div role="group" aria-labelledby={id} className="py-3 border-t border-zinc-800/60">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div id={id} className="text-body text-zinc-200">{label}</div>
          <div className="text-caption text-zinc-500">
            {per}
            {badge && (
              <span className="ml-1.5 px-1.5 py-px rounded bg-zinc-800 text-eyebrow-sm uppercase text-zinc-400">{badge}</span>
            )}
          </div>
        </div>
        <div className="flex items-center shrink-0">
          <button type="button" aria-label={lessLabel} onClick={less} disabled={!less} className={button}>
            <Minus size={14} aria-hidden="true" />
          </button>
          <output aria-live="polite" className="min-w-[84px] text-center font-display text-number-xs text-zinc-50 tabular-nums">
            {shown}
          </output>
          <button type="button" aria-label={moreLabel} onClick={more} disabled={!more} className={button}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <p className="mt-1.5 text-caption leading-relaxed text-zinc-500">{note}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── data streams

type Kind = 'ok' | 'behind' | 'empty' | 'unshared' | 'failed';

/** A daily stream whose latest reading is this many days old has stopped arriving. */
const BEHIND_AFTER = 3;

const KIND: Record<Kind, { summary: MessageKey; text: string; dot: string }> = {
  ok: { summary: 'data.streams.summary.ok', text: 'text-zinc-300', dot: 'bg-emerald-400' },
  behind: { summary: 'data.streams.summary.behind', text: 'text-amber-300', dot: 'bg-amber-400' },
  empty: { summary: 'data.streams.summary.empty', text: 'text-zinc-500', dot: 'ring-1 ring-inset ring-zinc-600' },
  unshared: { summary: 'data.streams.summary.unshared', text: 'text-zinc-400', dot: '' },
  failed: { summary: 'data.streams.summary.failed', text: 'text-rose-400', dot: 'bg-rose-400' },
};

const DOMAINS: MetricDomain[] = ['movement', 'sleep', 'cardio', 'body', 'wellbeing'];
/** Each group's heading. */
const DOMAIN_NAMES = {
  movement: 'data.streams.domains.movement',
  sleep: 'data.streams.domains.sleep',
  cardio: 'data.streams.domains.cardio',
  body: 'data.streams.domains.body',
  wellbeing: 'data.streams.domains.wellbeing',
} as const satisfies Record<MetricDomain, MessageKey>;
/** On wide screens the groups sit in two columns of about the same height. */
const LEFT: MetricDomain[] = ['movement', 'sleep', 'body'];

/** Registry order within a group, minute-level heart rate leading the vitals. */
const order = (dataType: string) =>
  dataType === INTRADAY_HEART_RATE.dataType ? -1 : STREAMS.findIndex((s) => s.dataType === dataType);

function kindOf(r: StreamReport, today: CivilDate): Kind {
  if (r.status === 'skipped') return 'unshared';
  if (r.status === 'error' || r.status === 'unauthorized') return 'failed';
  if (!r.latestDate) return 'empty';
  const occasional = STREAMS_BY_TYPE.get(r.dataType)?.occasional ?? false;
  return !occasional && daysBetween(r.latestDate, today) >= BEHIND_AFTER ? 'behind' : 'ok';
}

/** Today, yesterday or a date, for the messages to say: "14 Aug", or "2 Mar 2025" from another year. */
function when(date: CivilDate, today: CivilDate): { day: 'today' | 'yesterday' | 'date'; date: string } {
  const n = daysBetween(date, today);
  return {
    day: n <= 0 ? 'today' : n === 1 ? 'yesterday' : 'date',
    date: date.slice(0, 4) === today.slice(0, 4) ? formatCivil(date) : formatCivilYear(date),
  };
}

/**
 * What a reading's source is called: a device's or app's own name, or a platform's, as it came. A
 * device Google knows only by its kind ("WATCH") is stored under the kind's English name ("Watch"),
 * so the language file names that one, when it knows the kind.
 */
function deviceName(src: SourceRef): string {
  if (src.app) return src.label;
  const kind = src.formFactor;
  if (kind) {
    // The label normalize.ts stores for a source it knows only by this kind.
    if (src.label !== parseSource({ device: { formFactor: kind } })?.label) return src.label;
    const key = `data.streams.formFactors.${kind.toUpperCase()}`;
    return hasMessage(key) ? t(key) : src.label;
  }
  // A source Google says nothing about is stored as "Unknown".
  return src.platform === 'UNKNOWN' && src.label === parseSource({})?.label ? t('data.streams.unknownSource') : src.label;
}

interface StreamRow {
  report: StreamReport;
  kind: Kind;
  /** What the row says on the right: the latest reading's day when all is well, else what's wrong. */
  status: string;
  /** The sentence an opened row starts with. */
  detail: string;
  /** The last fetch, for whoever wants it. */
  fetch: string;
}

/**
 * Everything Healthier reads from Google Health, in plain names, grouped like
 * the app's pages. Each row says one thing: the day of its latest reading, or
 * what's wrong (behind, nothing recorded, not shared, failed). Opening a row
 * explains it in a sentence and then gives the raw dataType, the last fetch's
 * numbers and Google's own error.
 *
 * The fetch numbers describe only the stream's latest fetch, which after the
 * first sync is usually just the last few days, so they stay in the detail
 * rather than sitting beside the window's day counts as if they described them.
 */
export function DataStreams({ data }: { data: SyncResult }) {
  const [open, setOpen] = useState<string | null>(null);
  const wide = useMediaQuery('(min-width: 768px)');
  const today = data.meta.to;
  const windowDays = data.days.length;

  // Minute-level heart rate counts minutes, not days: count the days that have any.
  const heartRateDays = useMemo(() => new Set((data.heartRateSamples ?? []).map((s) => s.date)).size, [data.heartRateSamples]);

  const rows = useMemo(() => {
    /** The device behind a day's reading ("from Google Pixel Watch 3"), or logged by hand, when it's known. */
    const source = (dataType: string, date: CivilDate | undefined) => {
      const id = date ? data.days.find((d) => d.date === date)?.sourceByType[dataType] : undefined;
      const src = id ? data.meta.sources.find((s) => s.id === id) : undefined;
      return { source: !src ? 'none' : src.method === 'MANUAL' ? 'hand' : 'device', device: src ? deviceName(src) : '' };
    };

    return data.meta.streams.map((r): StreamRow => {
      const kind = kindOf(r, today);
      const latest = r.latestDate;
      const day = latest ? when(latest, today) : { day: 'date', date: '' };
      const intraday = r.dataType === INTRADAY_HEART_RATE.dataType;
      const days = intraday ? heartRateDays : r.observations;
      const coverage = days === windowDays
        ? t(intraday ? 'data.streams.coverage.everyDayMinutes' : 'data.streams.coverage.everyDay')
        : t(intraday ? 'data.streams.coverage.someDaysMinutes' : 'data.streams.coverage.someDays', { days, total: windowDays });

      let status: string;
      let detail: string;
      switch (kind) {
        case 'ok': {
          status = t('data.streams.status.latest', day);
          const reading = { when: t('data.streams.latestWhen', day), ...source(r.dataType, latest) };
          detail = STREAMS_BY_TYPE.get(r.dataType)?.occasional
            ? t('data.streams.detail.occasional', reading)
            : t(intraday ? 'data.streams.detail.latestMinute' : 'data.streams.detail.latestReading', { ...reading, coverage });
          break;
        }
        case 'behind':
          status = t('data.streams.status.behind', { date: day.date });
          detail = t('data.streams.detail.behind', { date: day.date });
          break;
        case 'empty':
          status = t('data.streams.status.empty');
          detail = t('data.streams.detail.empty');
          break;
        case 'unshared':
          status = t('data.streams.status.unshared');
          detail = t('data.streams.detail.unshared');
          break;
        case 'failed':
          status = t(r.status === 'unauthorized' ? 'data.streams.status.unauthorized' : 'data.streams.status.failed');
          detail = t(r.status === 'unauthorized' ? 'data.streams.detail.unauthorized' : 'data.streams.detail.failed');
          break;
      }

      const how = t(intraday ? 'data.streams.fetch.minutes' : r.mode === 'rollup' ? 'data.streams.fetch.totals' : 'data.streams.fetch.readings');
      const last = { how, requests: r.requests, pages: r.pagesFetched, ms: r.ms };
      const fetch = kind === 'unshared'
        ? t('data.streams.fetch.none')
        : r.httpStatus && r.httpStatus !== 200
          ? t('data.streams.fetch.lastWithStatus', { ...last, status: r.httpStatus })
          : t('data.streams.fetch.last', last);
      return { report: r, kind, status, detail: r.truncated ? t('data.streams.detail.truncated', { detail }) : detail, fetch };
    });
  }, [data, today, windowDays, heartRateDays]);

  const groups = DOMAINS.map((domain) => ({
    domain,
    rows: rows.filter((r) => r.report.domain === domain).sort((a, b) => order(a.report.dataType) - order(b.report.dataType)),
  })).filter((g) => g.rows.length);
  const columns = wide
    ? [groups.filter((g) => LEFT.includes(g.domain)), groups.filter((g) => !LEFT.includes(g.domain))]
    : [groups];
  const counts = (Object.keys(KIND) as Kind[])
    .map((kind) => ({ kind, n: rows.filter((r) => r.kind === kind).length }))
    .filter((c) => c.n > 0);

  return (
    <Card>
      <CardHead
        title={t('data.streams.title')}
        domain="data"
        hint={t('data.streams.hint')}
      />
      <ul aria-label={t('data.streams.summary.label')} className="px-5 -mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption text-zinc-400">
        {counts.map(({ kind, n }) => (
          <li key={kind} className="flex items-center gap-1.5">
            <Mark kind={kind} />
            <span>
              {rich(KIND[kind].summary, { count: n, b: (w) => <span className="font-semibold text-zinc-200 tabular-nums">{w}</span> })}
            </span>
          </li>
        ))}
      </ul>
      <div className="px-5 pb-3 pt-1 grid grid-cols-1 md:grid-cols-2 gap-x-10 items-start">
        {columns.map((col, i) => (
          <div key={i} className="min-w-0">
            {col.map((g) => (
              <div key={g.domain} className="pt-2">
                <h4 className="pt-2 pb-1 text-eyebrow uppercase text-zinc-500">{t(DOMAIN_NAMES[g.domain])}</h4>
                <ul>
                  {g.rows.map((row) => (
                    <StreamItem
                      key={row.report.dataType}
                      row={row}
                      open={open === row.report.dataType}
                      onToggle={() => setOpen((o) => (o === row.report.dataType ? null : row.report.dataType))}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** A stream's state at a glance: a dot, hollow when there's nothing, or a lock when it isn't shared. */
function Mark({ kind }: { kind: Kind }) {
  return kind === 'unshared' ? (
    <Lock size={11} aria-hidden="true" className="shrink-0 text-zinc-400" />
  ) : (
    <span aria-hidden="true" className={`shrink-0 w-1.5 h-1.5 rounded-full ${KIND[kind].dot}`} />
  );
}

function StreamItem({ row, open, onToggle }: { row: StreamRow; open: boolean; onToggle: () => void }) {
  const r = row.report;
  const id = `stream-${r.dataType}`;
  return (
    <li className="border-t border-zinc-800/60">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="w-full min-h-11 md:min-h-10 flex items-center gap-2.5 py-2 text-left"
      >
        <span className="flex-1 min-w-0 truncate text-body-sm text-zinc-200">{streamName(r.dataType, r.label)}</span>
        <span className={`shrink-0 flex items-center gap-1.5 text-detail ${KIND[row.kind].text}`}>
          <Mark kind={row.kind} />
          {row.status}
        </span>
        <ChevronDown size={14} aria-hidden="true" className={`shrink-0 text-zinc-600 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div id={id} className="pb-3.5">
          <p className="text-detail leading-relaxed text-zinc-400">{row.detail}</p>
          {row.kind === 'failed' && r.error && (
            <p className="mt-2 p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 font-mono text-caption text-rose-400 whitespace-pre-wrap break-words">
              {r.error}
            </p>
          )}
          <p className="mt-2 text-note text-zinc-500">
            <code className="font-mono text-zinc-400">{r.dataType}</code> · {row.fetch}
          </p>
        </div>
      )}
    </li>
  );
}
