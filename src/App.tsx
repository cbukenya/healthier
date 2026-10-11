import React, { useState, useEffect, useMemo } from 'react';
import type { IntradaySample } from './types/health';
import { FileCode2, FlaskConical, Footprints, Heart, Moon, RefreshCw, User, ShieldAlert, PersonStanding } from 'lucide-react';
import { useAuth } from './hooks/useAuth';
import { useHealth } from './hooks/useHealth';
import { DASHBOARD_WINDOW_DAYS } from './pipeline/sync';

import { DOMAIN, NavButton } from './ui/primitives';
import { TodayView } from './views/TodayView';
import { ActivityView } from './views/ActivityView';
import { SleepView } from './views/SleepView';
import { VitalsView } from './views/VitalsView';
import { BodyView } from './views/BodyView';
import { DataView } from './views/DataView';
import { LabsView } from './views/LabsView';

export default function App() {
  const { user, needsReconnect, ready, signIn, signOut, deleteAccount, reload } = useAuth();
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

  const disconnect = async () => {
    if (!window.confirm('Disconnect Google and permanently delete all of your data stored by Healthier?')) return;
    try {
      await deleteAccount();
    } catch (err) {
      console.error(err);
      window.alert('Could not delete your data. Please try again.');
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

  const [view, setView] = useState<'today' | 'activity' | 'sleep' | 'vitals' | 'body' | 'labs' | 'data'>('today');

  useEffect(() => {
    if (user || demo) {
      setView('today');
    }
  }, [user, demo]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="w-5 h-5 rounded-full border-2 border-zinc-800 border-t-zinc-400 animate-spin" />
      </div>
    );
  }

  if ((!user || needsReconnect) && !demo) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-6">
        <div className="max-w-md w-full p-8 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl">
          <div className="w-12 h-12 rounded-xl bg-zinc-800 flex items-center justify-center mb-6">
            <Heart size={24} className="text-zinc-400" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Healthier</h1>
          <p className="text-sm text-zinc-400 mb-8 leading-relaxed">
            {needsReconnect
              ? 'Your Google connection has expired or was revoked. Reconnect to resume syncing; your stored data is still here.'
              : 'A personalized health and fitness tracker that connects with your Google Health data. It establishes rolling baselines and presents actionable trend analysis to help you understand your body better.'}
          </p>
          {authError && (
            <p className="mb-6 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-[12px] text-rose-400">
              {authError === 'access_denied'
                ? 'Google sign-in was cancelled.'
                : authError === 'not_invited'
                  ? 'This Healthier instance is invite-only, and that Google account is not on its list. Ask whoever runs it to add you.'
                  : `Google sign-in failed (${authError}). Check the server logs for details.`}
            </p>
          )}
          <div className="space-y-3">
            <button
              onClick={signIn}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-white text-black font-semibold hover:bg-zinc-200 transition-colors"
            >
              {needsReconnect ? 'Reconnect Google Account' : 'Connect Google Account'}
            </button>
            <button
              onClick={() => setDemo(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-zinc-800 text-white font-medium hover:bg-zinc-700 transition-colors"
            >
              Demo mode
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-zinc-300 font-sans selection:bg-zinc-800 selection:text-white">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-black/80 backdrop-blur-md border-b border-zinc-800/80">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center">
              <Heart size={14} className="text-zinc-400" />
            </div>
            <span className="text-sm font-semibold text-white tracking-wide">Healthier</span>
          </div>
          
          <div className="flex items-center gap-3">
            {health.phase === 'revalidating' && (
              <span className="flex items-center gap-1.5 text-[11px] text-zinc-500 mr-2">
                <RefreshCw size={10} className="animate-spin" />
                syncing
              </span>
            )}
            
            {user && !demo && (
              <div className="flex items-center gap-2 px-2 py-1 rounded-full bg-zinc-900 border border-zinc-800/80">
                {user.pictureUrl ? (
                  <img src={user.pictureUrl} alt="Profile" className="w-5 h-5 rounded-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <div className="w-5 h-5 rounded-full bg-zinc-800 flex items-center justify-center">
                    <User size={10} className="text-zinc-400" />
                  </div>
                )}
                <span className="text-[11px] font-medium text-zinc-300 pr-1">
                  {user.name?.split(' ')[0] || 'User'}
                </span>
              </div>
            )}

            <button
              onClick={() => {
                if (demo) setDemo(false);
                else signOut();
              }}
              className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              {demo ? 'Exit Demo' : 'Sign Out'}
            </button>
          </div>
        </div>
      </header>

      {/* Navigation & Status */}
      <div className="max-w-5xl mx-auto px-4 py-6">
        <nav className="flex items-center gap-1 overflow-x-auto pb-2 scrollbar-hide">
          <NavButton 
            active={view === 'today'} onClick={() => setView('today')} 
            icon={<User size={14} />} label="Today" 
          />
          <NavButton 
            active={view === 'activity'} onClick={() => setView('activity')} 
            icon={<Footprints size={14} />} label="Activity" color={DOMAIN.movement.text} 
          />
          <NavButton 
            active={view === 'sleep'} onClick={() => setView('sleep')} 
            icon={<Moon size={14} />} label="Sleep" color={DOMAIN.sleep.text} 
          />
          <NavButton 
            active={view === 'vitals'} onClick={() => setView('vitals')} 
            icon={<Heart size={14} />} label="Vitals" color={DOMAIN.cardio.text} 
          />
          <NavButton 
            active={view === 'body'} onClick={() => setView('body')} 
            icon={<PersonStanding size={14} />} label="Body" color={DOMAIN.body.text} 
          />
          <NavButton 
            active={view === 'labs'} onClick={() => setView('labs')} 
            icon={<FlaskConical size={14} />} label="Labs" color="text-yellow-400" 
          />
          <div className="w-px h-4 bg-zinc-800 mx-2 shrink-0" />
          <NavButton 
            active={view === 'data'} onClick={() => setView('data')} 
            icon={<FileCode2 size={14} />} label="Data" color="text-zinc-400" 
          />
        </nav>

        {health.error && health.phase === 'error' && (
          <div className="mt-4 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-start gap-3">
            <ShieldAlert size={16} className="text-rose-400 mt-0.5 shrink-0" />
            <div className="flex-1">
              <h3 className="text-[12px] font-semibold text-rose-400">Sync Failed</h3>
              <p className="text-[11px] text-rose-400/80 mt-1">{health.error}</p>
            </div>
            <button 
              onClick={health.refresh}
              className="px-3 py-1.5 rounded-lg bg-rose-500/20 text-rose-300 text-[11px] font-medium hover:bg-rose-500/30 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {health.phase === 'loading' && demo && (
          <div className="mt-12 flex flex-col items-center justify-center text-zinc-500">
            <div className="w-6 h-6 rounded-full border-2 border-zinc-800 border-t-zinc-400 animate-spin mb-4" />
            <p className="text-[11px] uppercase tracking-wider">Loading sample data...</p>
          </div>
        )}

        {/* First sync (or a rebuild after an upgrade): the insights need the whole window, so wait for it. */}
        {health.phase === 'loading' && !demo && (
          <div className="mt-12 max-w-md mx-auto p-6 rounded-2xl bg-zinc-900 border border-zinc-800">
            <h2 className="text-sm font-semibold text-white">Building your health baseline</h2>
            <p className="mt-2 text-[12px] text-zinc-400 leading-relaxed">
              Importing your last {DASHBOARD_WINDOW_DAYS} days from Google Health, including minute-by-minute heart
              rate. Baselines and insights are computed over the full window, so the dashboard opens once it is all
              in. This usually takes under a minute, and only happens once.
            </p>
            <div className="mt-5 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${health.progress ? Math.round((health.progress.done / health.progress.total) * 100) : 2}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-zinc-500 tabular-nums">
              {health.progress
                ? `${health.progress.label} imported · ${health.progress.done} of ${health.progress.total}`
                : 'Connecting to Google Health...'}
            </p>
          </div>
        )}

        {health.data && (
          <main className="mt-6 animate-in fade-in duration-500">
            {view === 'today' && <TodayView data={health.data} intraday={intradayDays} />}
            {view === 'activity' && <ActivityView data={health.data} />}
            {view === 'sleep' && <SleepView data={health.data} />}
            {view === 'vitals' && <VitalsView data={health.data} />}
            {view === 'body' && <BodyView data={health.data} />}
            {view === 'labs' && <LabsView data={health.data} intraday={intradayDays} />}
            {view === 'data' && <DataView data={health.data} onFullSync={health.fullSync} onDisconnect={demo ? undefined : disconnect} />}
          </main>
        )}
      </div>
    </div>
  );
}
