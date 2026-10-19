import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IntradaySample } from './types/health';
import { ChevronLeft, ChevronRight, CircleDotDashed, FileCode2, FlaskConical, Footprints, Heart, Moon, RefreshCw, User, ShieldAlert, PersonStanding } from 'lucide-react';
import { useAuth } from './hooks/useAuth';
import { useInstance } from './hooks/useInstance';
import { useHealth } from './hooks/useHealth';
import { HistoryProvider } from './hooks/useHistory';
import { GoalsProvider } from './hooks/useGoals';
import { CycleProvider, useCycleTracking } from './hooks/useCycle';
import { ThemeProvider } from './hooks/useTheme';
import { CycleView } from './views/CycleView';
import { DASHBOARD_WINDOW_DAYS } from './pipeline/sync';
import { DEMO_CLOCK } from './pipeline/demo';
import { formatCivilDay } from './i18n/format';
import { t } from './i18n';
import { streamName } from './i18n/streams';
import { failureText } from './i18n/sync';
import { api } from './lib/api';
import type { Gender } from './pipeline/registry';
import { readGoals, type Goals } from './pipeline/goals';
import type { ApiUser, GoalsResponse, ProfileResponse } from './types/api';

import { DOMAIN, NavButton } from './ui/primitives';
import { TodayView } from './views/TodayView';
import { ActivityView } from './views/ActivityView';
import { SleepView } from './views/SleepView';
import { VitalsView } from './views/VitalsView';
import { BodyView } from './views/BodyView';
import { DataView, type SectionId } from './views/DataView';
import { LabsView } from './views/LabsView';
import { AboutYourData, GoogleG, SignInNote } from './views/SignInParts';

export default function App() {
  const { user, needsReconnect, theme, ready, signIn, signOut, deleteAccount, reload } = useAuth();
  const instance = useInstance();
  const [demo, setDemo] = useState(false);
  // Set by the server when a Google sign-in comes back with an error, e.g. ?auth_error=access_denied.
  const [authError] = useState(() => new URLSearchParams(window.location.search).get('auth_error'));

  useEffect(() => {
    if (authError) window.history.replaceState(null, '', window.location.pathname);
  }, [authError]);

  const health = useHealth({
    live: !!user && !needsReconnect,
    demo,
    onSignInRequired: reload,
  });

  const saveGender = async (gender: Gender | null) => {
    await api<ProfileResponse>('/api/profile', { method: 'PUT', body: { gender } });
  };

  // The gender the person set, from their profile until they change it on the Body page. The app
  // keeps it so Today's figure follows a change at once; in demo mode it lasts as long as the page.
  const [genderChoice, setGenderChoice] = useState<Gender | null | undefined>(undefined);
  useEffect(() => setGenderChoice(undefined), [user, demo]);
  const gender = genderChoice === undefined ? health.data?.profile?.gender ?? null : genderChoice;
  const chooseGender = (next: Gender | null) => {
    const before = gender;
    setGenderChoice(next);
    if (demo) return;
    saveGender(next).catch((err) => {
      console.error('Failed to save gender:', err);
      setGenderChoice(before);
    });
  };

  // Goals come with the dataset; read once per dataset so every screen sees the same object.
  const savedGoals = useMemo(() => readGoals(health.data?.profile?.goals), [health.data]);
  const saveGoals = useMemo(
    () => async (goals: Goals) => {
      await api<GoalsResponse>('/api/goals', { method: 'PUT', body: { goals } });
    },
    [],
  );

  /** Out of the demo, or signed out, keeping the data. */
  const leave = () => {
    if (demo) setDemo(false);
    else void signOut();
  };

  const disconnect = async () => {
    if (!window.confirm(t('app.disconnect.confirm'))) return;
    try {
      await deleteAccount();
    } catch (err) {
      console.error(err);
      window.alert(t('app.disconnect.failed'));
    }
  };

  const intradayDays = useMemo(() => {
    if (!health.data?.heartRateSamples) return {};
    const map: Record<string, IntradaySample[]> = {};
    for (const sample of health.data.heartRateSamples) {
      if (!map[sample.date]) map[sample.date] = [];
      map[sample.date].push(sample);
    }
    return map;
  }, [health.data]);

  const [view, setView] = useState<View>('today');
  // A Data section to open: the chip in the bar asks for Account.
  const [dataRequest, setDataRequest] = useState<{ section: SectionId; at: number } | null>(null);
  const openAccount = () => {
    setView('data');
    setDataRequest({ section: 'account', at: Date.now() });
  };
  // The data's last day: yours on live data, the fixture's in demo mode.
  const today = health.data?.days.at(-1)?.date ?? null;

  useEffect(() => {
    if (user || demo) {
      setView('today');
    }
  }, [user, demo]);

  // A page opened from the bar starts at its top, not where the last one was left.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

  const bar = usePinnedHeight();

  // Every screen in the person's theme, the sign-in screen included.
  const themed = (screen: React.ReactNode) => <ThemeProvider saved={user ? theme : undefined} demo={demo}>{screen}</ThemeProvider>;

  if (!ready || !instance) {
    return themed(
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 rounded-full border-2 border-zinc-800 border-t-zinc-400 animate-spin" />
      </div>
    );
  }

  if ((!user || needsReconnect) && !demo) {
    return themed(
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="relative max-w-md w-full p-8 rounded-2xl bg-card border border-card-edge shadow-2xl">
          <AboutYourData />
          <img src="/logo.svg" alt="" width={48} height={48} className="mb-6" />
          <h1 className="font-display text-display text-white mb-2">{t('app.name')}</h1>
          <p className="text-body text-zinc-400 mb-8 leading-relaxed">
            {needsReconnect ? t('app.signIn.expired') : t('app.signIn.intro')}
          </p>
          {authError && (
            <p className="mb-6 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-detail text-rose-400">
              {authError === 'access_denied'
                ? t('app.signIn.cancelled')
                : authError === 'not_invited'
                  ? t('app.signIn.notInvited')
                  : t('app.signIn.failed', { code: authError })}
            </p>
          )}
          <div className="space-y-3">
            <button
              onClick={signIn}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-white text-black font-semibold hover:bg-zinc-200 transition-colors"
            >
              <GoogleG />
              {needsReconnect ? t('app.signIn.reconnect') : t('app.signIn.connect')}
            </button>
            {instance.demo && (
              <button
                onClick={() => setDemo(true)}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-zinc-800 text-white font-medium hover:bg-zinc-700 transition-colors"
              >
                {t('app.signIn.demo')}
              </button>
            )}
          </div>
          {instance.note && <SignInNote note={instance.note} />}
        </div>
      </div>
    );
  }

  const shell = (
      <div className="max-w-5xl mx-auto px-4 pt-2 pb-6 md:pt-3">
        {today && (
          <time dateTime={today} className="block px-3 text-right text-detail text-page-ink">
            {formatCivilDay(today)}
          </time>
        )}

        {health.error && health.phase === 'error' && (
          <div className="mt-4 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-start gap-3">
            <ShieldAlert size={16} className="text-rose-400 mt-0.5 shrink-0" />
            <div className="flex-1">
              <h3 className="text-detail font-semibold text-rose-400">{t('app.syncFailed.title')}</h3>
              <p className="text-caption text-rose-400/80 mt-1">{failureText(health.error)}</p>
            </div>
            <button 
              onClick={health.refresh}
              className="px-3 py-1.5 rounded-lg bg-rose-500/20 text-rose-300 text-caption font-medium hover:bg-rose-500/30 transition-colors"
            >
              {t('app.syncFailed.retry')}
            </button>
          </div>
        )}

        {health.phase === 'loading' && demo && (
          <div className="mt-12 flex flex-col items-center justify-center text-zinc-500">
            <div className="w-6 h-6 rounded-full border-2 border-zinc-800 border-t-zinc-400 animate-spin mb-4" />
            <p className="text-caption uppercase tracking-wider">{t('app.loadingDemo')}</p>
          </div>
        )}

        {/* First sync (or a rebuild after an upgrade): the insights need the whole window, so wait for it. */}
        {health.phase === 'loading' && !demo && (
          <div className="mt-12 max-w-md mx-auto p-6 rounded-2xl bg-card border border-card-edge">
            <h2 className="card-title-detail text-white">{t('app.firstSync.title')}</h2>
            <p className="mt-2 text-detail text-zinc-400 leading-relaxed">{t('app.firstSync.body', { days: DASHBOARD_WINDOW_DAYS })}</p>
            <div className="mt-5 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${health.progress ? Math.round((health.progress.done / health.progress.total) * 100) : 2}%` }}
              />
            </div>
            <p className="mt-2 text-caption text-zinc-500 tabular-nums">
              {health.progress
                ? t('app.firstSync.progress', {
                    stream: streamName(health.progress.dataType, health.progress.label),
                    done: health.progress.done,
                    total: health.progress.total,
                  })
                : t('app.firstSync.connecting')}
            </p>
          </div>
        )}

        {health.data && (
          <GoalsProvider saved={savedGoals} save={demo ? undefined : saveGoals}>
          <HistoryProvider data={health.data} info={health.history} live={!demo} local={health.localHistory}>
          <main className="mt-3 md:mt-6 animate-in fade-in duration-500">
            {view === 'today' && <TodayView data={health.data} gender={gender} intraday={intradayDays} clock={demo ? DEMO_CLOCK : undefined} />}
            {view === 'activity' && <ActivityView data={health.data} intraday={intradayDays} clock={demo ? DEMO_CLOCK : undefined} />}
            {view === 'sleep' && <SleepView data={health.data} intraday={intradayDays} clock={demo ? DEMO_CLOCK : undefined} />}
            {view === 'vitals' && <VitalsView data={health.data} intraday={intradayDays} clock={demo ? DEMO_CLOCK : undefined} />}
            {view === 'body' && <BodyView data={health.data} gender={gender} onGender={chooseGender} intraday={intradayDays} clock={demo ? DEMO_CLOCK : undefined} />}
            {view === 'cycle' && <CycleView data={health.data} intraday={intradayDays} clock={demo ? DEMO_CLOCK : undefined} />}
            {view === 'labs' && <LabsView data={health.data} intraday={intradayDays} />}
            {view === 'data' && (
              <DataView
                data={health.data}
                live={!demo}
                syncing={health.phase === 'revalidating'}
                failure={health.error}
                email={demo ? null : user?.email ?? null}
                request={dataRequest}
                onRequestDone={() => setDataRequest(null)}
                onFullSync={health.fullSync}
                onRetry={health.refresh}
                onSignIn={signIn}
                onSignOut={leave}
                onDisconnect={demo ? undefined : disconnect}
                onSourcesChanged={(refetching) => void (refetching ? health.refresh() : health.reload())}
              />
            )}
          </main>
          </HistoryProvider>
          </GoalsProvider>
        )}
      </div>
  );

  // The bar and the page icons are pinned together, solid, so no page is ever behind the bar: iOS
  // Safari can shift a pinned bar out of place, and anything sliding under it got lost there. The
  // padding keeps the bar clear of the status bar when Healthier runs from the Home Screen.
  const page = (
    <>
      <header ref={bar} className="sticky top-0 z-30 bg-(--bar) backdrop-blur-xl border-b border-card-edge pt-[env(safe-area-inset-top)]">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="" width={28} height={28} />
            <span className="text-body font-semibold text-white tracking-wide">{t('app.name')}</span>
          </div>
          
          <div className="flex items-center gap-3">
            {health.phase === 'revalidating' && (
              <span className="flex items-center gap-1.5 text-caption text-zinc-500 mr-2">
                <RefreshCw size={10} className="animate-spin" />
                {t('app.header.syncing')}
              </span>
            )}
            
            {(demo || user) && <AccountChip user={demo ? null : user} onClick={openAccount} />}
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 pt-1 md:pt-2">
          <PageNav view={view} setView={setView} />
        </div>
      </header>
      {shell}
    </>
  );

  return themed(
    <div className="min-h-screen text-zinc-300 font-sans selection:bg-zinc-800 selection:text-white">
      {/* Cycle tracking reaches the page icons as well as the pages. */}
      {health.data ? <CycleProvider data={health.data} live={!demo}>{page}</CycleProvider> : page}
    </div>
  );
}

type View = 'today' | 'activity' | 'sleep' | 'vitals' | 'body' | 'cycle' | 'labs' | 'data';

/**
 * Who's here, in the bar: their picture and first name, or Demo in demo mode. It opens the Data
 * page at Account, where the theme is set and where signing out, or leaving the demo, now lives.
 */
function AccountChip({ user, onClick }: { user: ApiUser | null; onClick: () => void }) {
  const name = user ? user.name?.split(' ')[0] || t('app.header.someone') : t('app.header.demo');
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('app.header.account', { name })}
      // The ::before widens what a finger can hit to 44px tall, without making the chip bigger.
      className="relative flex items-center gap-2 px-2 py-1 rounded-full bg-zinc-900 border border-zinc-800/80 hover:bg-zinc-800 transition-colors before:absolute before:-inset-y-2 before:inset-x-0 before:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
    >
      {user?.pictureUrl ? (
        <img src={user.pictureUrl} alt="" className="w-5 h-5 rounded-full object-cover" referrerPolicy="no-referrer" />
      ) : (
        <span className="w-5 h-5 rounded-full bg-zinc-800 flex items-center justify-center">
          <User size={10} className="text-zinc-400" />
        </span>
      )}
      <span className="text-caption font-medium text-zinc-300 pr-1">{name}</span>
    </button>
  );
}

/**
 * The bar's height as `--bar-height` on the page, for whatever sticks under the bar: the Data
 * page's section list. It changes with the text size, so it's measured, not assumed.
 */
function usePinnedHeight() {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--bar-height', `${el.offsetHeight}px`);
    set();
    observer.current = new ResizeObserver(set);
    observer.current.observe(el);
  }, []);
}

/** How far from the row's edge the open page is kept, clear of the fade. */
const EDGE = 48;

/**
 * The pages, the Cycle page among them while cycle tracking is on. On a narrow phone they don't
 * all fit: the row scrolls sideways on its own, by swipe, trackpad or mouse wheel, and an edge
 * with pages past it shows a small arrow that slides the row along.
 */
function PageNav({ view, setView }: { view: View; setView: (view: View) => void }) {
  const tracking = useCycleTracking();
  // Turning tracking off on the Data page takes the Cycle page away; never leave anyone on it.
  useEffect(() => {
    if (view === 'cycle' && !tracking) setView('today');
  }, [view, tracking, setView]);

  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ before: false, after: false });
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    const before = el.scrollLeft > 1;
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.before === before && e.after === after ? e : { before, after }));
  }, []);

  /** Scrolls the row so the open page is in view, clear of the fade. */
  const reveal = useCallback(() => {
    const el = row.current;
    const open = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && open) {
      const start = open.offsetLeft;
      const end = start + open.offsetWidth;
      if (start - EDGE < el.scrollLeft) el.scrollLeft = start - EDGE;
      else if (end + EDGE > el.scrollLeft + el.clientWidth) el.scrollLeft = end + EDGE - el.clientWidth;
    }
    measure();
  }, [measure]);
  useLayoutEffect(reveal, [view, tracking, reveal]);

  // A turned phone, a new text size or the fonts arriving change what fits, and how wide the open page is.
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const observer = new ResizeObserver(reveal);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    void document.fonts?.ready.then(reveal);
    return () => observer.disconnect();
  }, [tracking, reveal]);

  // A mouse wheel turns the row while it has pages past an edge, then hands back to the page.
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const next = Math.min(el.scrollWidth - el.clientWidth, Math.max(0, el.scrollLeft + e.deltaY));
      if (Math.round(next) === Math.round(el.scrollLeft)) return;
      e.preventDefault();
      el.scrollLeft = next;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const slide = (direction: 1 | -1) => {
    const el = row.current;
    el?.scrollBy({ left: direction * Math.round(el.clientWidth * 0.6), behavior: 'smooth' });
  };

  return (
    <nav aria-label={t('app.nav.label')}>
      <div
        ref={row}
        onScroll={measure}
        className="relative flex items-center justify-between md:justify-start gap-0.5 md:gap-1 overflow-x-auto overscroll-x-contain pb-2 no-scrollbar"
      >
        {edges.before && <RowEdge side="start" onClick={() => slide(-1)} />}
        <NavButton
          active={view === 'today'} onClick={() => setView('today')}
          icon={<User size={14} />} label={t('app.nav.today')}
        />
        <NavButton
          active={view === 'activity'} onClick={() => setView('activity')}
          icon={<Footprints size={14} />} label={t('app.nav.activity')} color={DOMAIN.movement.text}
        />
        <NavButton
          active={view === 'sleep'} onClick={() => setView('sleep')}
          icon={<Moon size={14} />} label={t('app.nav.sleep')} color={DOMAIN.sleep.text}
        />
        <NavButton
          active={view === 'vitals'} onClick={() => setView('vitals')}
          icon={<Heart size={14} />} label={t('app.nav.vitals')} color={DOMAIN.cardio.text}
        />
        <NavButton
          active={view === 'body'} onClick={() => setView('body')}
          icon={<PersonStanding size={14} />} label={t('app.nav.body')} color={DOMAIN.body.text}
        />
        {tracking && (
          <NavButton
            active={view === 'cycle'} onClick={() => setView('cycle')}
            icon={<CircleDotDashed size={14} />} label={t('app.nav.cycle')} color={DOMAIN.cycle.text}
          />
        )}
        <NavButton
          active={view === 'labs'} onClick={() => setView('labs')}
          icon={<FlaskConical size={14} />} label={t('app.nav.labs')} color="text-yellow-400"
        />
        {/* Sets Data apart. On phones it gives way when the row is full, so it never pushes Data out of view. */}
        <div className="flex justify-center w-[19px] -mx-px min-w-0 shrink overflow-hidden md:w-auto md:mx-2 md:shrink-0">
          <div className="w-px h-4 shrink-0 bg-bar-rule" />
        </div>
        <NavButton
          active={view === 'data'} onClick={() => setView('data')}
          icon={<FileCode2 size={14} />} label={t('app.nav.data')} color="text-zinc-400"
        />
        {edges.after && <RowEdge side="end" onClick={() => slide(1)} />}
      </div>
    </nav>
  );
}

/**
 * An edge of the page row with pages past it: an arrow that slides the row along. It sits inside
 * the row, pinned to its visible edge, so a swipe that starts on it still scrolls it. No fade: over
 * the glass bar, a fade would draw a band of its own colour.
 * The arrow is for fingers; a keyboard reaches every page by tabbing along the row. Its negative
 * margin takes back the row's gap, so showing an edge never changes how far the row scrolls.
 */
function RowEdge({ side, onClick }: { side: 'start' | 'end'; onClick: () => void }) {
  const start = side === 'start';
  return (
    <div className={`sticky z-10 w-0 shrink-0 self-stretch ${start ? 'left-0 -mr-0.5 md:-mr-1' : 'right-0 -ml-0.5 md:-ml-1'}`}>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClick}
        className={`absolute top-0 h-10 md:h-full w-9 flex items-center text-zinc-400 hover:text-zinc-200 ${start ? 'left-0 justify-start' : 'right-0 justify-end'}`}
      >
        <span className="size-6 rounded-full bg-zinc-800 flex items-center justify-center">
          {start ? <ChevronLeft size={14} strokeWidth={2.5} /> : <ChevronRight size={14} strokeWidth={2.5} />}
        </span>
      </button>
    </div>
  );
}
