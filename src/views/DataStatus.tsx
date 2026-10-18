import React, { useEffect, useState } from 'react';
import { LogIn, RefreshCw } from 'lucide-react';
import { dataStatus, type DataStatus } from '../lib/dataStatus';
import { addDays, todayCivil } from '../lib/date';
import { formatCivil, formatClock, formatFixed, formatList, formatMonthYearShort } from '../i18n/format';
import { t } from '../i18n';
import { streamNameInText } from '../i18n/streams';
import { failureText } from '../i18n/sync';
import type { SyncFailure } from '../hooks/useHealth';
import type { SyncResult } from '../pipeline/sync';
import type { HistoryInfo } from '../types/api';
import { Card } from '../ui/primitives';
import { when } from './DataStreams';

/**
 * The first thing on the Data page: where your data stands, in a sentence, with what to do
 * about it. Up to date, a stream that's stopped arriving, history still importing, or a sync
 * that's failing, each with the button that fits: a full sync, a retry, or signing in again.
 * Under it, the window, how far back history goes, and the last sync's cost.
 */

/** The most streams a title names before it counts them instead. */
const NAMED = 3;

/** A date or time that stays on one line, so a title never ends on "4" with "Oct" below it. */
const unbroken = (s: string) => s.replace(/ /g, '\u00a0');

const DOT: Record<DataStatus['kind'], string> = {
  current: 'bg-emerald-400 ring-emerald-400/20',
  behind: 'bg-amber-400 ring-amber-400/20',
  importing: 'bg-sky-400 ring-sky-400/20',
  failed: 'bg-rose-400 ring-rose-400/20',
  failing: 'bg-rose-400 ring-rose-400/20',
  expired: 'bg-rose-400 ring-rose-400/20',
};

/** "Synced just now", "Synced 12 minutes ago", "Synced 3 hours ago", "Synced 2 days ago". */
function syncedAgo(then: number, now: number): string {
  const min = Math.floor((now - then) / 60_000);
  if (min < 1) return t('data.status.synced.justNow');
  if (min < 60) return t('data.status.synced.minutes', { count: min });
  const h = Math.floor(min / 60);
  return h < 24 ? t('data.status.synced.hours', { count: h }) : t('data.status.synced.days', { count: Math.floor(h / 24) });
}

/** The title and the line under it, and for a failed sync, the reason in its own words. */
function sentences(status: DataStatus, data: SyncResult, synced: number | null, now: number, demo: boolean) {
  /** Streams by their names inside a sentence, joined the language's way. */
  const named = (dataTypes: string[], join: 'and' | 'or') =>
    formatList(dataTypes.map((dt) => streamNameInText(dt, data.meta.streams.find((r) => r.dataType === dt)?.label ?? dt)), join);
  switch (status.kind) {
    case 'current':
      return { title: t('data.status.current.title'), sub: t(demo ? 'data.status.current.demo' : 'data.status.current.sub') };
    case 'behind': {
      const count = status.streams.length;
      return {
        title: t('data.status.behind.title', {
          list: count <= NAMED ? 'yes' : 'no',
          streams: named(status.streams, 'or'),
          count,
          date: unbroken(when(status.since, data.meta.to).date),
        }),
        sub: t('data.status.behind.sub', { count }),
      };
    }
    case 'failed': {
      const count = status.streams.length;
      return {
        title: t('data.status.failed.title', { list: count <= NAMED ? 'yes' : 'no', streams: named(status.streams, 'and'), count }),
        sub: t('data.status.failed.sub'),
      };
    }
    case 'importing':
      return { title: t('data.status.importing.title'), sub: t('data.status.importing.sub', { count: data.days.length }) };
    case 'failing': {
      // When it last synced, on this device's clock: a time today, yesterday, or a date.
      const at = synced === null ? null : new Date(synced);
      const today = todayCivil(new Date(now));
      const day = at ? todayCivil(at) : null;
      return {
        title: t('data.status.failing.title', {
          day: !day ? 'none' : day === today ? 'today' : day === addDays(today, -1) ? 'yesterday' : 'date',
          time: at ? unbroken(formatClock(at.getHours() * 60 + at.getMinutes())) : '',
          date: day ? unbroken(formatCivil(day)) : '',
        }),
        sub: t('data.status.failing.sub'),
        reason: failureText(status.failure),
      };
    }
    case 'expired':
      return { title: t('data.status.expired.title'), sub: t('data.status.expired.sub') };
  }
}

export function StatusCard({ data, history, syncing, failure, demo, onFullSync, onRetry, onSignIn }: {
  data: SyncResult;
  history: HistoryInfo | null;
  /** A sync is running now. */
  syncing: boolean;
  /** Why the last sync failed, when it did. */
  failure: SyncFailure | null;
  demo: boolean;
  onFullSync: () => void;
  onRetry: () => void;
  onSignIn: () => void;
}) {
  // A minute's tick keeps "12 minutes ago" true while the page stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { meta } = data;
  const status = dataStatus({ failure, history, streams: meta.streams, today: meta.to });
  const parsed = Date.parse(meta.finishedAt);
  const synced = Number.isNaN(parsed) ? null : parsed;
  const failing = status.kind === 'failing' || status.kind === 'expired';
  const { title, sub, reason } = sentences(status, data, synced, now, demo);
  const eyebrow = syncing
    ? t('data.status.syncing')
    : failing
      ? t('data.status.syncFailed')
      : synced !== null
        ? syncedAgo(synced, now)
        : null;
  const action = status.kind === 'expired'
    ? { label: t('data.status.signIn'), hint: undefined, onClick: onSignIn }
    : status.kind === 'failing'
      ? { label: t('app.syncFailed.retry'), hint: undefined, onClick: onRetry }
      : { label: t('data.status.fullSync'), hint: t('data.status.fullSyncHint'), onClick: onFullSync };
  const took = meta.ms < 1000
    ? t('data.status.lastSync.milliseconds', { ms: meta.ms })
    : t('data.status.lastSync.seconds', { seconds: formatFixed(meta.ms / 1000, 1) });
  const historyNote = !history?.from
    ? null
    : history.backfilling
      ? { text: t('data.status.history.importing'), tone: 'text-amber-400' }
      : history.complete
        ? { text: t('data.status.history.complete'), tone: 'text-emerald-400' }
        : { text: t('data.status.history.incomplete'), tone: 'text-amber-400', hint: t('data.status.history.incompleteHint') };

  return (
    <Card label={t('data.status.label')} className="p-4 md:px-5">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 flex items-center gap-2.5 text-detail text-zinc-400">
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ring-3 ${DOT[status.kind]} ${syncing ? 'animate-pulse' : ''}`} />
          <span className="truncate">{eyebrow}</span>
        </p>
        <button
          type="button"
          onClick={action.onClick}
          title={action.hint}
          className="-my-1 shrink-0 min-h-11 md:min-h-9 inline-flex items-center gap-1.5 px-3.5 rounded-full border border-zinc-800 bg-zinc-900 text-caption font-medium text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          {status.kind === 'expired'
            ? <LogIn size={12} aria-hidden="true" />
            : <RefreshCw size={12} aria-hidden="true" className={syncing ? 'animate-spin' : ''} />}
          {action.label}
        </button>
      </div>
      <h2 className="mt-3 font-display text-headline text-zinc-50">{title}</h2>
      <p className="mt-1.5 text-detail leading-relaxed text-zinc-400">{sub}</p>
      {reason && <p className="mt-2 text-caption leading-relaxed text-rose-300/90 break-words">{reason}</p>}
      <dl className="mt-4 pt-3.5 border-t border-zinc-800/60 grid grid-cols-3 gap-3">
        <Fact
          label={t('data.status.window.label')}
          value={t('data.status.window.days', { count: data.days.length })}
          note={t('data.status.window.range', { from: formatCivil(meta.from), to: formatCivil(meta.to) })}
        />
        <Fact
          label={t('data.status.history.label')}
          value={history?.from ? formatMonthYearShort(history.from) : '—'}
          note={historyNote?.text}
          noteTone={historyNote?.tone}
          noteHint={historyNote?.hint}
        />
        <Fact
          label={t('data.status.lastSync.label')}
          value={took}
          note={t('data.status.lastSync.requests', { count: meta.totalRequests })}
        />
      </dl>
    </Card>
  );
}

function Fact({ label, value, note, noteTone = 'text-zinc-500', noteHint }: {
  label: string;
  value: string;
  note?: string;
  noteTone?: string;
  noteHint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-eyebrow-sm uppercase text-zinc-500">{label}</dt>
      <dd className="mt-0.5 font-display text-title text-zinc-100 tabular-nums">{value}</dd>
      {note && <dd className={`text-caption leading-snug ${noteTone}`} title={noteHint}>{note}</dd>}
    </div>
  );
}
