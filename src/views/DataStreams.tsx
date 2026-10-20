import React, { memo, useMemo, useState } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { daysBetween, type CivilDate } from '../lib/date';
import { STREAM_DOMAINS, streamKind, streamOrder, type StreamKind } from '../lib/dataStatus';
import { bucketLabel, formatCivil, formatCivilNumeric, formatCivilYear, formatClock, formatHour } from '../i18n/format';
import { hasMessage, t, type MessageKey } from '../i18n';
import { rich } from '../i18n/react';
import { streamError, streamName } from '../i18n/streams';
import { bucketStart, groupDays, mean, type Bucket } from '../pipeline/aggregate';
import { parseSource } from '../pipeline/normalize';
import { INTRADAY_HEART_RATE, STREAMS_BY_TYPE } from '../pipeline/registry';
import { DASHBOARD_WINDOW_DAYS, type SyncResult } from '../pipeline/sync';
import type { MetricDomain, SourceRef, StreamReport } from '../types/health';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { Segmented } from '../ui/primitives';
import { SpanSelector, useSpan } from '../ui/span';
import { SectionCard, useSectionScreen } from './DataCards';
import { SECTION_TONE } from './sectionTones';

/**
 * Data streams: everything Healthier reads from Google Health, one row each, grouped like the
 * app's pages. A row says one thing on the right, the day of its latest reading or what's wrong
 * (behind, nothing recorded, not shared, failed), and draws the selected span as a strip of
 * blocks, solid where a reading arrived. Opening a row explains it in a sentence and gives the
 * raw dataType, the last fetch's numbers and Google's own error; minute-level heart rate also
 * shows its minutes hour by hour.
 *
 * The fetch numbers describe only the stream's latest fetch, which after the first sync is
 * usually just the last few days, so they stay in the detail rather than sitting beside the
 * strip's day counts as if they described them.
 */

const KIND: Record<StreamKind, { summary: MessageKey; text: string; dot: string }> = {
  ok: { summary: 'data.streams.summary.ok', text: 'text-zinc-300', dot: SECTION_TONE.streams.fill },
  behind: { summary: 'data.streams.summary.behind', text: 'text-amber-300', dot: 'bg-amber-400' },
  empty: { summary: 'data.streams.summary.empty', text: 'text-zinc-500', dot: 'ring-1 ring-inset ring-zinc-600' },
  unshared: { summary: 'data.streams.summary.unshared', text: 'text-zinc-400', dot: '' },
  failed: { summary: 'data.streams.summary.failed', text: 'text-rose-400', dot: 'bg-rose-400' },
};

/** Each group's heading. */
const DOMAIN_NAMES = {
  movement: 'data.streams.domains.movement',
  sleep: 'data.streams.domains.sleep',
  cardio: 'data.streams.domains.cardio',
  body: 'data.streams.domains.body',
  wellbeing: 'data.streams.domains.wellbeing',
} as const satisfies Record<MetricDomain, MessageKey>;

const HINTS = {
  day: 'data.streams.hint.day',
  week: 'data.streams.hint.week',
  month: 'data.streams.hint.month',
} as const satisfies Record<Bucket, MessageKey>;

/** A row on a wide card: name, strip, days with a reading, latest, and the arrow. */
const WIDE_ROW = '@xl:grid-cols-[10rem_minmax(0,1fr)_3.25rem_6.5rem_1rem]';

/** How many streams are in each state, those with any, in the order the summary names them. */
function streamCounts(reports: StreamReport[], today: CivilDate) {
  return (Object.keys(KIND) as StreamKind[])
    .map((kind) => ({ kind, n: reports.filter((r) => streamKind(r, today) === kind).length }))
    .filter((c) => c.n > 0);
}

/** The counts in plain words, for the Data page's list: "20 up to date · 4 with nothing recorded". */
export function streamsSummary(data: SyncResult): string {
  return streamCounts(data.meta.streams, data.meta.to)
    .map(({ kind, n }) => t(KIND[kind].summary, { count: n }))
    .join(' · ');
}

/** Today, yesterday or a date, for the messages to say: "14 Aug", or "2 Mar 2025" from another year. */
export function when(date: CivilDate, today: CivilDate): { day: 'today' | 'yesterday' | 'date'; date: string } {
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

/** A block of the strip: a day, or a week or month of days, as indexes into the span's days. */
interface Block {
  date: CivilDate;
  from: number;
  to: number;
}

/** What one block of a stream's strip shows. */
interface Cell {
  key: CivilDate;
  /** Tailwind classes for its colour. */
  tone: string;
  /** A week's or month's share of days with a reading, as opacity; a day is solid. */
  opacity?: number;
  title: string;
}

interface StreamRow {
  report: StreamReport;
  name: string;
  kind: StreamKind;
  /** What the row says on the right: the latest reading's day when all is well, else what's wrong. */
  status: string;
  /** The sentence an opened row starts with. */
  detail: string;
  /** The last fetch, for whoever wants it. */
  fetch: string;
  cells: Cell[];
  /** Days with a reading out of the span's days: "58/90". */
  count: string;
}

export function DataStreams({ data }: { data: SyncResult }) {
  const screen = useSectionScreen();
  // A phone's narrow strip reads best over a month; a wider one has room for three.
  const wide = useMediaQuery('(min-width: 768px)');
  const span = useSpan(data, wide ? '90' : '30');
  const [open, setOpen] = useState<string | null>(INTRADAY_HEART_RATE.dataType);
  const today = data.meta.to;
  const windowDays = data.days.length;

  // Minutes of heart rate recorded per hour, per day: counted once, for the strip and the hours.
  const minutesByDay = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const s of data.heartRateSamples ?? []) {
      let hours = out.get(s.date);
      if (!hours) out.set(s.date, (hours = new Array(24).fill(0)));
      const h = Math.floor(s.minutesOfDay / 60);
      if (h >= 0 && h < 24) hours[h]++;
    }
    return out;
  }, [data.heartRateSamples]);

  const blocks = useMemo(() => {
    const out: Block[] = [];
    span.days.forEach((d, i) => {
      const key = bucketStart(d.date, span.bucket);
      const last = out[out.length - 1];
      if (last && last.date === key) last.to = i;
      else out.push({ date: key, from: i, to: i });
    });
    return out;
  }, [span.days, span.bucket]);

  const rows = useMemo(() => {
    const days = span.days;
    const bucket = span.bucket;
    // Minutes are kept for the window only; older days have none to show.
    const minutesFrom = data.days[0]?.date ?? today;

    /** The device behind a day's reading ("from Google Pixel Watch 3"), or logged by hand, when it's known. */
    const source = (dataType: string, date: CivilDate | undefined) => {
      const id = date ? data.days.find((d) => d.date === date)?.sourceByType[dataType] : undefined;
      const src = id ? data.meta.sources.find((s) => s.id === id) : undefined;
      return { source: !src ? 'none' : src.method === 'MANUAL' ? 'hand' : 'device', device: src ? deviceName(src) : '' };
    };

    return data.meta.streams.map((r): StreamRow => {
      const name = streamName(r.dataType, r.label);
      const kind = streamKind(r, today);
      const latest = r.latestDate;
      const day = latest ? when(latest, today) : { day: 'date', date: '' };
      const intraday = r.dataType === INTRADAY_HEART_RATE.dataType;
      const inWindow = intraday ? data.days.filter((d) => minutesByDay.has(d.date)).length : r.observations;
      const coverage = inWindow === windowDays
        ? t(intraday ? 'data.streams.coverage.everyDayMinutes' : 'data.streams.coverage.everyDay')
        : t(intraday ? 'data.streams.coverage.someDaysMinutes' : 'data.streams.coverage.someDays', { days: inWindow, total: windowDays });

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
        : r.mode === 'derived'
          ? t('data.streams.fetch.derived')
          : r.httpStatus && r.httpStatus !== 200
          ? t('data.streams.fetch.lastWithStatus', { ...last, status: r.httpStatus })
          : t('data.streams.fetch.last', last);

      // Each block of the strip: solid for a day with a reading, a week or month by its share of them.
      const has = days.map((d) => (intraday ? minutesByDay.has(d.date) : d.present.includes(r.dataType)));
      const cells = blocks.map((b): Cell => {
        const total = b.to - b.from + 1;
        const at = bucket === 'day' ? formatCivilNumeric(days[b.from].date) : bucketLabel(b.date, bucket, 'full');
        if (intraday && days[b.to].date < minutesFrom) {
          return { key: b.date, tone: 'bg-faint', title: t('data.streams.notKept', { date: at, stream: name }) };
        }
        let recorded = 0;
        for (let i = b.from; i <= b.to; i++) if (has[i]) recorded++;
        return {
          key: b.date,
          tone: recorded ? 'bg-sky-500' : 'bg-zinc-800',
          opacity: recorded && bucket !== 'day' ? 0.25 + 0.75 * (recorded / total) : undefined,
          title: bucket === 'day'
            ? t(recorded ? 'charts.coverage.dayRecorded' : 'charts.coverage.dayMissing', { date: at, stream: name })
            : t('charts.coverage.bucket', { date: at, stream: name, recorded, total }),
        };
      });
      const count = t('charts.coverage.count', { observed: has.filter(Boolean).length, total: days.length });

      return {
        report: r, name, kind, status, cells, count, fetch,
        detail: r.truncated ? t('data.streams.detail.truncated', { detail }) : detail,
      };
    });
  }, [data, today, windowDays, minutesByDay, span.days, span.bucket, blocks]);

  const groups = STREAM_DOMAINS.map((domain) => ({
    domain,
    rows: rows.filter((r) => r.report.domain === domain).sort((a, b) => streamOrder(a.report.dataType) - streamOrder(b.report.dataType)),
  })).filter((g) => g.rows.length);
  const counts = streamCounts(data.meta.streams, today);
  // The strip's first, middle and last blocks, named over it on a wide card.
  const ticks = blocks.length ? [blocks[0], blocks[Math.floor(blocks.length / 2)], blocks[blocks.length - 1]] : [];

  return (
    <SectionCard title={t('data.streams.title')} hint={t(HINTS[span.bucket])} right={<SpanSelector state={span} />}>
      <div className="@container px-5 pb-3">
        <ul aria-label={t('data.streams.summary.label')} className={`${screen ? 'pt-3' : '-mt-1'} flex flex-wrap gap-x-4 gap-y-1 text-caption text-zinc-400`}>
          {counts.map(({ kind, n }) => (
            <li key={kind} className="flex items-center gap-1.5">
              <Mark kind={kind} />
              <span>
                {rich(KIND[kind].summary, { count: n, b: (w) => <span className="font-semibold text-zinc-200 tabular-nums">{w}</span> })}
              </span>
            </li>
          ))}
        </ul>
        <div aria-hidden="true" className={`hidden @xl:grid ${WIDE_ROW} gap-x-3 pt-4 text-note text-zinc-500`}>
          <span />
          <span className="flex justify-between gap-2 whitespace-nowrap">
            {ticks.map((b, i) => <span key={i}>{bucketLabel(b.date, span.bucket)}</span>)}
          </span>
          <span className="text-right">{t('data.streams.columns.days')}</span>
          <span>{t('data.streams.columns.latest')}</span>
          <span />
        </div>
        {groups.map((g) => (
          <div key={g.domain} className="pt-2">
            <h4 className="pt-2 pb-1 text-eyebrow uppercase text-zinc-500">{t(DOMAIN_NAMES[g.domain])}</h4>
            <ul>
              {g.rows.map((row) => (
                <StreamItem
                  key={row.report.dataType}
                  row={row}
                  open={open === row.report.dataType}
                  onToggle={() => setOpen((o) => (o === row.report.dataType ? null : row.report.dataType))}
                  hours={row.report.dataType === INTRADAY_HEART_RATE.dataType ? <MinuteHours data={data} minutesByDay={minutesByDay} /> : null}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

/** A stream's state at a glance: a dot, hollow when there's nothing, or a lock when it isn't shared. */
function Mark({ kind }: { kind: StreamKind }) {
  return kind === 'unshared' ? (
    <Lock size={11} aria-hidden="true" className="shrink-0 text-zinc-400" />
  ) : (
    <span aria-hidden="true" className={`shrink-0 w-1.5 h-1.5 rounded-full ${KIND[kind].dot}`} />
  );
}

function StreamItem({ row, open, onToggle, hours }: { row: StreamRow; open: boolean; onToggle: () => void; hours: React.ReactNode }) {
  const r = row.report;
  const id = `stream-${r.dataType}`;
  const error = row.kind === 'failed' ? streamError(r) : undefined;
  return (
    <li className="border-t border-zinc-800/60">
      {/* On a narrow card the strip runs under the name; on a wide one it sits between name and status. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className={`w-full min-h-11 grid grid-cols-[minmax(0,1fr)_auto_auto] ${WIDE_ROW} items-center gap-x-3 gap-y-2 py-2.5 @xl:py-2 text-left`}
      >
        <span title={row.name} className={`min-w-0 truncate text-body-sm ${row.kind === 'ok' || row.kind === 'behind' ? 'text-zinc-200' : 'text-zinc-400'}`}>
          {row.name}
        </span>
        <Strip cells={row.cells} />
        <span className="hidden @xl:block text-right text-note text-zinc-500 tabular-nums">{row.count}</span>
        <span className={`flex items-center gap-1.5 whitespace-nowrap text-detail ${KIND[row.kind].text}`}>
          <Mark kind={row.kind} />
          {row.status}
        </span>
        <ChevronDown size={14} aria-hidden="true" className={`shrink-0 text-zinc-600 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div id={id} className="pb-3.5">
          <p className="max-w-[72ch] text-detail leading-relaxed text-zinc-400">{row.detail}</p>
          {error && (
            <p className="mt-2 p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 font-mono text-caption text-rose-400 whitespace-pre-wrap break-words">
              {error}
            </p>
          )}
          {hours}
          <p className="mt-2 text-note text-zinc-500">
            <code className="font-mono text-zinc-400">{r.dataType}</code> · {row.fetch}
          </p>
        </div>
      )}
    </li>
  );
}

/**
 * The span as a strip of blocks, one per day, week or month, always apart like the bars on the
 * other pages. A long span packs them closer, a pixel apart, but never into one bar.
 */
const Strip = memo(function Strip({ cells }: { cells: Cell[] }) {
  const n = cells.length;
  return (
    <span aria-hidden="true" className={`col-span-3 row-start-2 @xl:col-span-1 @xl:row-start-auto flex h-2.5 @xl:h-3 ${n <= 31 ? 'gap-0.5' : 'gap-px'}`}>
      {cells.map((c) => (
        <span
          key={c.key}
          title={c.title}
          className={`flex-1 min-w-0 ${n <= 62 ? 'rounded-[1.5px]' : 'rounded-[1px]'} ${c.tone}`}
          style={c.opacity === undefined ? undefined : { opacity: c.opacity }}
        />
      ))}
    </span>
  );
});

/**
 * Minute-level heart rate, hour by hour: how many minutes of each hour have a reading, over the
 * last two weeks, a month, or every week minute data is kept. It shows when the watch is worn.
 */
function MinuteHours({ data, minutesByDay }: { data: SyncResult; minutesByDay: Map<string, number[]> }) {
  const [span, setSpan] = useState<'14' | '30' | '62'>('14');
  const rows = useMemo(() => {
    const days = data.days.slice(-Number(span));
    const hoursOf = (date: string) => minutesByDay.get(date) ?? NO_HOURS;
    if (span !== '62') {
      return [...days].reverse().map((d, i) => ({
        key: d.date,
        label: i === 0 ? t('data.intraday.today') : formatCivil(d.date),
        title: formatCivil(d.date),
        minutes: hoursOf(d.date),
        days: 1,
      }));
    }
    // Two months of daily rows is too tall to read: one row per week, each hour the average across its days.
    return groupDays(days, 'week')
      .reverse()
      .map((g) => ({
        key: g.date,
        label: bucketLabel(g.date, 'week'),
        title: bucketLabel(g.date, 'week', 'full'),
        minutes: Array.from({ length: 24 }, (_, h) => mean(g.days.map((d) => hoursOf(d.date)[h])) ?? 0),
        days: g.days.length,
      }));
  }, [data.days, span, minutesByDay]);
  const dense = rows.length > 20;

  return (
    <div className="mt-3 p-3 md:p-3.5 rounded-xl bg-black/40 border border-zinc-800/70">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-eyebrow uppercase text-zinc-500">{t('data.intraday.title')}</h5>
        <Segmented
          size="sm"
          value={span}
          onChange={setSpan}
          options={(['14', '30', '62'] as const).map((id) => ({ id, label: t('data.intraday.span', { days: Number(id) }) }))}
        />
      </div>
      <div className="mt-3 overflow-x-auto">
        <div className={`min-w-64 ${dense ? 'space-y-0.5' : 'space-y-1'}`}>
          <div aria-hidden="true" className="flex items-end gap-2 mb-1">
            <span className="w-12 shrink-0" />
            <div className="flex-1 grid grid-cols-24 text-micro text-zinc-500">
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h}>{h % 3 === 0 ? formatHour(h) : ''}</span>
              ))}
            </div>
          </div>
          {rows.map((row, index) => (
            <div key={row.key} className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-right text-note text-zinc-400 tabular-nums whitespace-nowrap">
                {rows.length <= 14 || index % 2 === 0 ? row.label : ''}
              </span>
              <div className="flex-1 grid grid-cols-24 gap-0.5">
                {row.minutes.map((m, h) => {
                  const hour = formatClock(h * 60);
                  return (
                    <span
                      key={h}
                      className={`${dense ? 'h-2' : 'h-2.5'} rounded-[2px] ${tone(m)}`}
                      title={
                        row.days === 1
                          ? t('data.intraday.cell', { date: row.title, time: hour, minutes: m })
                          : t('data.intraday.cellAverage', { date: row.title, time: hour, minutes: Math.round(m), days: row.days })
                      }
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <p className="flex-[1_1_16rem] text-caption leading-relaxed text-zinc-500">
          {span === '62'
            ? t('data.intraday.hintWeekly', { days: DASHBOARD_WINDOW_DAYS })
            : t('data.intraday.hint', { days: Number(span) })}
        </p>
        <span aria-hidden="true" className="flex items-center gap-1 text-note text-zinc-500">
          {t('data.intraday.less')}
          {[0, 10, 30, 60].map((m) => <span key={m} className={`size-2.5 rounded-[2px] ${tone(m)}`} />)}
          {t('data.intraday.more')}
        </span>
      </div>
    </div>
  );
}

const NO_HOURS: number[] = new Array(24).fill(0);

/** An hour's colour by the minutes recorded in it: most of it reads solid. */
const tone = (m: number) => (m === 0 ? 'bg-zinc-800/60' : m < 15 ? 'bg-sky-500/25' : m < 45 ? 'bg-sky-500/55' : 'bg-sky-500');
