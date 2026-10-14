import React, { useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, Lock, Minus, Plus, RefreshCw } from 'lucide-react';
import { daysBetween, formatCivil, type CivilDate } from '../lib/date';
import { BASELINE_DAYS, NEED_ESTIMATE } from '../pipeline/derive';
import { REFETCH_DAYS } from '../pipeline/incremental';
import { DEFAULT_GOALS, GOAL_LIMITS, WHO_WEEK, fitGoal, sameGoals, type GoalLimit, type Goals } from '../pipeline/goals';
import { DOMAIN_LABELS, INTRADAY_HEART_RATE, STREAMS, STREAMS_BY_TYPE } from '../pipeline/registry';
import type { SyncResult } from '../pipeline/sync';
import type { HistoryInfo } from '../types/api';
import type { MetricDomain, StreamReport } from '../types/health';
import { useGoalsControl } from '../hooks/useGoals';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { Card, CardHead, DURATION_UNIT, fmtDuration, withUnits } from '../ui/primitives';

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

// ─────────────────────────────────────────────────────────── sync status

/** "Just now", "12 minutes ago", "3 hours ago", "2 days ago". */
function ago(then: number, now: number): string {
  const min = Math.floor((now - then) / 60_000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${plural(min, 'minute')} ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${plural(h, 'hour')} ago` : `${plural(Math.floor(h / 24), 'day')} ago`;
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
  const took = meta.ms < 1000 ? `${meta.ms} ms` : `${(meta.ms / 1000).toFixed(1)} s`;

  return (
    <Card>
      <CardHead
        title="Sync status"
        right={
          <button
            onClick={onFullSync}
            title="Fetch the whole window from Google again, not just the last few days"
            className="-my-2.5 md:-my-1 min-h-11 md:min-h-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors text-caption font-medium text-zinc-200"
          >
            <RefreshCw size={12} aria-hidden="true" /> Full sync
          </button>
        }
      />
      <dl className="px-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-caption">
        <dt className="text-zinc-500">Last synced</dt>
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
        <dt className="text-zinc-500">Window</dt>
        <dd className="text-right text-zinc-200 tabular-nums">
          {formatCivil(meta.from)} → {formatCivil(meta.to)} · {data.days.length} days
        </dd>
        {history?.from && (
          <>
            <dt className="text-zinc-500">History</dt>
            <dd className="text-right text-zinc-200">
              from {formatCivil(history.from)} {history.from.slice(0, 4)} ·{' '}
              {history.backfilling ? (
                <span className="text-amber-400">importing…</span>
              ) : history.complete ? (
                <span className="text-emerald-400">complete</span>
              ) : (
                <span className="text-amber-400" title="Some streams failed to import; they retry after the next sync.">incomplete, retrying</span>
              )}
            </dd>
          </>
        )}
      </dl>
      <div className="mt-3 pl-5 pr-2 py-0.5 min-h-10 border-t border-zinc-800/60 flex items-center justify-between gap-3">
        <span className="text-note text-zinc-500 tabular-nums">
          Last sync: {plural(meta.totalRequests, 'request')} in {took}
        </span>
        {onDisconnect && (
          <button
            onClick={onDisconnect}
            className="min-h-11 md:min-h-9 px-3 rounded-lg text-caption font-medium text-rose-400 hover:bg-rose-500/10 transition-colors"
          >
            Disconnect &amp; delete data
          </button>
        )}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────── data facts

/** "August 2024". */
const monthYear = (date: CivilDate) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

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
  const reach = historyFrom && historyFrom < windowFrom ? `, and the longer views go back to ${monthYear(historyFrom)}` : '';
  const facts: [lead: string, text: string][] = [
    [
      'No AI guesswork',
      "Every score and insight is calculated from your own data, with nothing written or guessed by AI. Sleep stages and cardio fitness are your watch's own estimates.",
    ],
    [
      'Usual means usual for you',
      `Anything called usual or unusual is compared with your own last ${BASELINE_DAYS} days, not with other people. One odd day won't change what's normal for you.`,
    ],
    [
      `The last ${windowDays} days`,
      `Most of what you see covers the last ${windowDays} days${reach}. Every sync re-checks the last ${REFETCH_DAYS} days, because watches often send data late.`,
    ],
    [
      'Missing days stay blank',
      "A day with no data shows a dash, not a zero, and isn't counted in your averages. Today's steps only count once the day is over.",
    ],
    [
      'Heart rate, minute by minute',
      'Your watch measures your heart rate every few seconds. Healthier keeps one average per minute, so very short spikes are smoothed out.',
    ],
  ];
  return (
    <Card className={className}>
      <CardHead title="Data facts" domain="data" />
      <ul className="px-5 pb-2">
        {facts.map(([lead, text], i) => (
          <li key={lead} className={i ? 'py-3 border-t border-zinc-800/60' : 'pt-1 pb-3'}>
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
const hours = (min: number) => `${Math.floor(min / 60)}${min % 60 ? '½' : ''}`;

const DAYS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];

/** How many days at a daily brisk goal it takes to reach the WHO's week, if a week is enough. */
function briskNote(perDay: number): string {
  const days = Math.ceil(WHO_WEEK / perDay);
  return days <= 7
    ? `Your inner ring. ${DAYS[days]} days like that reach the WHO's ${WHO_WEEK} a week.`
    : `Your inner ring. Even every day, that stays under the WHO's ${WHO_WEEK} a week.`;
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
        title="Goals"
        hint="Google Health doesn't share the goals you set in Fitbit, so set them here."
        right={
          !sameGoals(goals, DEFAULT_GOALS) && (
            <button
              type="button"
              onClick={() => change(DEFAULT_GOALS)}
              className="-my-2.5 md:-my-1.5 -mr-2 min-h-11 md:min-h-0 px-2 md:py-1.5 rounded-lg text-caption font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
            >
              Reset to defaults
            </button>
          )
        }
      />
      <div className="px-5 pb-1.5">
        <GoalRow
          label="Steps"
          per="a day"
          shown={goals.steps.toLocaleString('en-GB')}
          {...stepper(goals.steps, L.steps, (v) => ({ steps: v }))}
          lessLabel="Fewer steps"
          moreLabel="More steps"
          note="Your outer ring, the steps chart's line and your streaks."
        />
        <GoalRow
          label="Brisk minutes"
          per="a day"
          shown={String(goals.briskMinutes)}
          {...stepper(goals.briskMinutes, L.briskMinutes, (v) => ({ briskMinutes: v }))}
          lessLabel="Fewer brisk minutes"
          moreLabel="More brisk minutes"
          note={briskNote(goals.briskMinutes)}
        />
        <GoalRow
          label="Sleep need"
          per="a night"
          badge={goals.sleepNeed === null ? 'Auto' : undefined}
          shown={withUnits(fmtDuration(need), DURATION_UNIT)}
          {...stepper(need, L.sleepNeed, (v) => ({ sleepNeed: v }))}
          lessLabel="Less sleep"
          moreLabel="More sleep"
          note={
            goals.sleepNeed === null ? (
              `Worked out from your recent nights, between ${hours(NEED_ESTIMATE.floor)} and ${hours(NEED_ESTIMATE.ceiling)} hours. Your body battery and sleep debt use it.`
            ) : (
              <>
                Your own figure, between {hours(L.sleepNeed.min)} and {hours(L.sleepNeed.max)} hours. Your body battery and sleep debt use it.{' '}
                <button
                  type="button"
                  onClick={() => set({ sleepNeed: null })}
                  className="text-zinc-300 underline underline-offset-2 hover:text-zinc-100"
                >
                  Back to auto
                </button>
              </>
            )
          }
        />
      </div>
      {failed && (
        <p role="alert" className="px-5 pb-4 text-caption text-rose-400">
          Couldn't save that change, so your goals are as they were. Try again.
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

const KIND: Record<Kind, { summary: string; text: string; dot: string }> = {
  ok: { summary: 'up to date', text: 'text-zinc-300', dot: 'bg-emerald-400' },
  behind: { summary: 'behind', text: 'text-amber-300', dot: 'bg-amber-400' },
  empty: { summary: 'with nothing recorded', text: 'text-zinc-500', dot: 'ring-1 ring-inset ring-zinc-600' },
  unshared: { summary: 'not shared', text: 'text-zinc-400', dot: '' },
  failed: { summary: 'failed', text: 'text-rose-400', dot: 'bg-rose-400' },
};

const DOMAINS: MetricDomain[] = ['movement', 'sleep', 'cardio', 'body', 'wellbeing'];
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

/** "Today", "Yesterday", "14 Aug", or "2 Mar 2025" from another year. */
function when(date: CivilDate, today: CivilDate): string {
  const n = daysBetween(date, today);
  if (n <= 0) return 'Today';
  if (n === 1) return 'Yesterday';
  return date.slice(0, 4) === today.slice(0, 4) ? formatCivil(date) : `${formatCivil(date)} ${date.slice(0, 4)}`;
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
    /** ", from Google Pixel Watch 3" for the device behind a day's reading, when it's known. */
    const source = (dataType: string, date: CivilDate | undefined) => {
      const id = date ? data.days.find((d) => d.date === date)?.sourceByType[dataType] : undefined;
      const src = id ? data.meta.sources.find((s) => s.id === id) : undefined;
      return !src ? '' : src.method === 'MANUAL' ? ', logged by hand' : `, from ${src.label}`;
    };

    return data.meta.streams.map((r): StreamRow => {
      const kind = kindOf(r, today);
      const latest = r.latestDate;
      const day = latest ? when(latest, today) : '';
      const lower = day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : `on ${day}`;
      const intraday = r.dataType === INTRADAY_HEART_RATE.dataType;
      const days = intraday ? heartRateDays : r.observations;
      const coverage = days === windowDays
        ? `Every day in the window has ${intraday ? 'some' : 'one'}.`
        : `${days} of the ${windowDays} days in the window have ${intraday ? 'some' : 'one'}.`;
      const truncated = r.truncated ? ' Google had more readings than one fetch takes, so some older ones may be missing.' : '';

      let status: string;
      let detail: string;
      switch (kind) {
        case 'ok':
          status = day;
          detail = STREAMS_BY_TYPE.get(r.dataType)?.occasional
            ? `Last reading ${lower}${source(r.dataType, latest)}. These come now and then, so a gap since the last one is normal.`
            : `Latest ${intraday ? 'minute' : 'reading'} ${lower}${source(r.dataType, latest)}. ${coverage}`;
          break;
        case 'behind':
          status = `Nothing since ${day}`;
          detail = `Nothing new since ${day}. Healthier asks for it on every sync, so it fills in as soon as your device records it again.`;
          break;
        case 'empty':
          status = 'Nothing recorded';
          detail = 'Google has no readings of this for you: none of your devices record it, or nothing has been logged.';
          break;
        case 'unshared':
          status = 'Not shared';
          detail = "Healthier wasn't given access to this when you connected Google, so it doesn't ask for it. To add it, sign out, sign back in and allow it when Google asks.";
          break;
        case 'failed':
          status = r.status === 'unauthorized' ? 'No access' : 'Failed';
          detail = r.status === 'unauthorized'
            ? "Google refused access to this on the last fetch. If you didn't allow it when connecting, sign out, sign back in and allow it."
            : 'Google answered the last fetch with an error, so the days already stored stay as they were. Healthier tries again on the next sync.';
          break;
      }

      const how = intraday ? 'one-minute averages' : r.mode === 'rollup' ? 'daily totals' : 'individual readings';
      const fetch = kind === 'unshared'
        ? 'not fetched'
        : `${how} · last fetch: ${plural(r.requests, 'request')}, ${plural(r.pagesFetched, 'page')}, ${r.ms} ms${r.httpStatus && r.httpStatus !== 200 ? `, HTTP ${r.httpStatus}` : ''}`;
      return { report: r, kind, status, detail: detail + truncated, fetch };
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
        title="Data streams"
        domain="data"
        hint="Everything Healthier reads from Google Health, and whether it's arriving. Open one to see where it comes from and what happened on the last fetch."
      />
      <ul aria-label="Summary" className="px-5 -mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption text-zinc-400">
        {counts.map(({ kind, n }) => (
          <li key={kind} className="flex items-center gap-1.5">
            <Mark kind={kind} />
            <span>
              <span className="font-semibold text-zinc-200 tabular-nums">{n}</span> {KIND[kind].summary}
            </span>
          </li>
        ))}
      </ul>
      <div className="px-5 pb-3 pt-1 grid grid-cols-1 md:grid-cols-2 gap-x-10 items-start">
        {columns.map((col, i) => (
          <div key={i} className="min-w-0">
            {col.map((g) => (
              <div key={g.domain} className="pt-2">
                <h4 className="pt-2 pb-1 text-eyebrow uppercase text-zinc-500">{DOMAIN_LABELS[g.domain]}</h4>
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
        <span className="flex-1 min-w-0 truncate text-body-sm text-zinc-200">{r.label}</span>
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
