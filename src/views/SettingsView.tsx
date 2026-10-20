import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, CircleDotDashed, CircleUserRound, Database, Target, Watch, type LucideIcon } from 'lucide-react';
import { t, type MessageKey } from '../i18n';
import { formatInteger } from '../i18n/format';
import { estimatedSleepTarget } from '../pipeline/derive';
import type { SyncResult } from '../pipeline/sync';
import type { SyncFailure } from '../hooks/useHealth';
import { useHistory } from '../hooks/useHistory';
import { useGoals } from '../hooks/useGoals';
import { useCycle } from '../hooks/useCycle';
import { useTheme } from '../hooks/useTheme';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { Card, fmtDuration } from '../ui/primitives';
import { AccountCard, CycleCard, DataFacts, GoalsCard, SectionScreen } from './DataCards';
import { DataStreams, streamsSummary } from './DataStreams';
import { StatusCard } from './DataStatus';
import { SourcesCard, sourcesSummary, useSources } from './SourcesCard';

/**
 * The Settings page: where your data stands, then its sections in three groups, each with a line on
 * what's in it. On a phone a section opens as a screen of its own, a step in the browser's
 * history so the back gesture closes it; on a wide screen the list stays on the left and the
 * open section fills the right, Devices and sources until another is picked.
 */

export type SectionId = 'devices' | 'streams' | 'goals' | 'cycle' | 'facts' | 'account';

const GROUPS: { title: MessageKey; sections: SectionId[] }[] = [
  { title: 'data.overview.groups.sources', sections: ['devices', 'streams'] },
  { title: 'data.overview.groups.preferences', sections: ['goals', 'cycle'] },
  { title: 'data.overview.groups.about', sections: ['facts', 'account'] },
];
const SECTIONS = GROUPS.flatMap((g) => g.sections);

/** What a wide screen shows beside the list until another section is picked. */
const FIRST: SectionId = 'devices';

const LOOK: Record<SectionId, { title: MessageKey; icon: LucideIcon; tile: string }> = {
  devices: { title: 'data.sources.title', icon: Watch, tile: 'bg-sky-400/12 text-sky-400' },
  streams: { title: 'data.streams.title', icon: Database, tile: 'bg-amber-400/12 text-amber-400' },
  goals: { title: 'data.goals.title', icon: Target, tile: 'bg-emerald-400/12 text-emerald-400' },
  cycle: { title: 'data.cycle.title', icon: CircleDotDashed, tile: 'bg-pink-400/12 text-pink-400' },
  facts: { title: 'data.facts.title', icon: BookOpen, tile: 'bg-violet-400/12 text-violet-400' },
  account: { title: 'data.account.title', icon: CircleUserRound, tile: 'bg-zinc-800 text-zinc-300' },
};

/** Where an open section's top sits on a wide screen: under the pinned bar, with a gap. */
const paneTop = () => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-height')) || 56) + 16;

/** The section a history entry opened, if any. */
function sectionIn(state: unknown): SectionId | null {
  const id = (state as { settingsSection?: unknown } | null)?.settingsSection;
  return SECTIONS.includes(id as SectionId) ? (id as SectionId) : null;
}

/** Leave the page's address as it was before any section opened. */
const forgetSection = () => window.history.replaceState(null, '', window.location.pathname + window.location.search);

export function SettingsView({
  data, live, syncing, failure, email, request, onRequestDone, onFullSync, onRetry, onSignIn, onSignOut, onDisconnect, onSourcesChanged,
}: {
  data: SyncResult;
  /** False in demo mode. */
  live: boolean;
  /** A sync is running now. */
  syncing: boolean;
  /** Why the last sync failed, when it did. */
  failure: SyncFailure | null;
  /** The Google account's address, when it's known. */
  email: string | null;
  /** A section asked for from elsewhere, such as Account from the chip in the bar; `at` tells one ask from the next. */
  request?: { section: SectionId; at: number } | null;
  /** The asked-for section is open, so the request can go. */
  onRequestDone?: () => void;
  onFullSync: () => void;
  onRetry: () => void;
  onSignIn: () => void;
  /** Signs out, or in demo mode leaves the demo. */
  onSignOut: () => void;
  /** Absent in demo mode, where there's nothing stored to delete. */
  onDisconnect?: () => void;
  /** After a new choice of devices: `refetching` when daily totals are being fetched again. */
  onSourcesChanged: (refetching: boolean) => void;
}) {
  const wide = useMediaQuery('(min-width: 1024px)');
  const history = useHistory().info;
  const sources = useSources(data, live, onSourcesChanged);
  const goals = useGoals();
  const { log } = useCycle();
  const { theme } = useTheme();
  const autoNeed = estimatedSleepTarget(data.days);
  const [section, setSection] = useState<SectionId | null>(null);

  // The back gesture closes a section opened on a phone, as it leaves any page.
  useEffect(() => {
    // A section left open when the page last went away isn't opened again.
    if (sectionIn(window.history.state)) forgetSection();
    const onPop = (e: PopStateEvent) => setSection(sectionIn(e.state));
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (sectionIn(window.history.state)) forgetSection();
    };
  }, []);

  const overviewScroll = useRef(0);
  const rows = useRef(new Map<SectionId, HTMLButtonElement>());
  const pane = useRef<HTMLDivElement>(null);
  const shown = useRef<SectionId | null>(null);
  // A phone's section starts at its top, and closing it returns to the row it was opened from.
  // On a wide screen, a section picked far down the page starts at its top too.
  useLayoutEffect(() => {
    const was = shown.current;
    if (was === section) return;
    shown.current = section;
    if (wide) {
      const want = paneTop();
      const top = pane.current?.getBoundingClientRect().top ?? want;
      if (top < want) window.scrollBy({ top: top - want });
      return;
    }
    if (section) {
      window.scrollTo({ top: 0 });
    } else {
      window.scrollTo({ top: overviewScroll.current });
      if (was) rows.current.get(was)?.focus({ preventScroll: true });
    }
  }, [section, wide]);

  const open = (id: SectionId) => {
    if (!wide) {
      overviewScroll.current = window.scrollY;
      window.history.pushState({ settingsSection: id }, '', `#settings/${id}`);
    }
    setSection(id);
  };
  // An asked-for section opens as a tap on its row would, unless it's open already. Each ask is
  // answered once, even where React runs an effect twice to check it.
  const answered = useRef<number | null>(null);
  useEffect(() => {
    if (!request || answered.current === request.at) return;
    answered.current = request.at;
    if (request.section !== section) open(request.section);
    onRequestDone?.();
  }, [request]);

  const back = () => {
    if (sectionIn(window.history.state)) window.history.back();
    else setSection(null);
  };

  const summaries: Record<SectionId, string> = {
    devices: sources.view ? sourcesSummary(sources.view) : '',
    streams: streamsSummary(data),
    goals: t('data.overview.summaries.goals', {
      steps: formatInteger(goals.steps),
      brisk: formatInteger(goals.briskMinutes),
      sleep: fmtDuration(goals.sleepNeed ?? autoNeed),
    }),
    cycle: t('data.overview.summaries.cycle', {
      tracking: log.settings.tracking ? 'on' : 'off',
      cards: log.settings.todayCards ? 'yes' : 'no',
    }),
    facts: t('data.overview.summaries.facts'),
    account: t(live ? 'data.overview.summaries.account' : 'data.overview.summaries.accountDemo', { theme }),
  };

  const render = (id: SectionId) => {
    switch (id) {
      case 'devices':
        return <SourcesCard data={data} live={live} sources={sources} />;
      case 'streams':
        return <DataStreams data={data} />;
      case 'goals':
        return <GoalsCard autoNeed={autoNeed} />;
      case 'cycle':
        return <CycleCard kept={!!data.profile?.cycleKept} />;
      case 'facts':
        return <DataFacts windowDays={data.days.length} windowFrom={data.meta.from} historyFrom={history?.from ?? null} />;
      case 'account':
        return <AccountCard email={email} demo={!live} onSignOut={onSignOut} onDisconnect={onDisconnect} />;
    }
  };

  const status = (
    <StatusCard
      data={data}
      history={history}
      syncing={syncing}
      failure={failure}
      demo={!live}
      onFullSync={onFullSync}
      onRetry={onRetry}
      onSignIn={onSignIn}
    />
  );
  const button = (id: SectionId, current = false) => (
    <SectionButton
      id={id}
      summary={summaries[id]}
      wide={wide}
      current={current}
      onClick={() => open(id)}
      buttonRef={(el) => {
        if (el) rows.current.set(id, el);
        else rows.current.delete(id);
      }}
    />
  );

  if (wide) {
    const picked = section ?? FIRST;
    return (
      <div className="flex gap-3">
        {/* As tall as the open section, so the list can stay in view beside a long one. */}
        <aside className="w-80 shrink-0 space-y-3">
          {status}
          <nav
            aria-label={t('data.overview.label')}
            className="sticky top-[calc(var(--bar-height,56px)+16px)] p-1.5 bg-card border border-card-edge rounded-2xl"
          >
            {GROUPS.map((g) => (
              <div key={g.title}>
                <h2 className="px-2.5 pt-3 pb-1 text-eyebrow uppercase text-zinc-500">{t(g.title)}</h2>
                <ul>
                  {g.sections.map((id) => <li key={id}>{button(id, id === picked)}</li>)}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
        <div ref={pane} className="flex-1 min-w-0">
          {render(picked)}
        </div>
      </div>
    );
  }

  if (section) {
    return (
      <SectionScreen value={true}>
        <button
          type="button"
          onClick={back}
          aria-label={t('data.overview.back')}
          className="-ml-2 min-h-11 inline-flex items-center gap-0.5 pl-1 pr-3 rounded-full text-body-sm font-medium text-zinc-300 hover:bg-zinc-800/60 transition-colors"
        >
          <ChevronLeft size={18} aria-hidden="true" />
          {t('app.nav.settings')}
        </button>
        {render(section)}
      </SectionScreen>
    );
  }

  return (
    <div>
      {status}
      <nav aria-label={t('data.overview.label')}>
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h2 className="mt-6 mb-2 px-1 text-eyebrow uppercase text-page-ink">{t(g.title)}</h2>
            <Card className="overflow-hidden">
              <ul>
                {g.sections.map((id, i) => (
                  <li key={id} className={i ? 'border-t border-zinc-800/60' : ''}>
                    {button(id)}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        ))}
      </nav>
    </div>
  );
}

/** A section's row in the list: its icon, its name, and a line on what's in it. */
function SectionButton({ id, summary, wide, current, onClick, buttonRef }: {
  id: SectionId;
  summary: string;
  wide: boolean;
  /** The section open beside the list. */
  current: boolean;
  onClick: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const { title, icon: Icon, tile } = LOOK[id];
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-current={current ? 'true' : undefined}
      className={
        wide
          ? `w-full min-h-14 flex items-center gap-3 px-2.5 py-2 rounded-xl text-left transition-colors ${current ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40'}`
          : 'w-full min-h-17 flex items-center gap-3.5 px-3.5 py-3 text-left transition-colors hover:bg-zinc-800/30 active:bg-zinc-800/50'
      }
    >
      <span aria-hidden="true" className={`shrink-0 flex items-center justify-center ${wide ? 'size-8.5 rounded-[10px]' : 'size-9.5 rounded-xl'} ${tile}`}>
        <Icon size={wide ? 16 : 18} />
      </span>
      <span className="flex-1 min-w-0">
        <span className={`block font-medium ${wide ? 'text-body-sm' : 'text-body'} ${current ? 'text-zinc-50' : 'text-zinc-200'}`}>{t(title)}</span>
        {summary && <span className={`block mt-0.5 truncate text-zinc-500 ${wide ? 'text-caption' : 'text-detail'}`}>{summary}</span>}
      </span>
      {!wide && <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-zinc-600" />}
    </button>
  );
}
