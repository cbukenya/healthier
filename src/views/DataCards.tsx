import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { CivilDate } from '../lib/date';
import { formatInteger, formatList, formatMonthYear } from '../i18n/format';
import { t, type MessageKey } from '../i18n';
import { rich } from '../i18n/react';
import { BASELINE_DAYS, NEED_ESTIMATE } from '../pipeline/derive';
import { REFETCH_DAYS } from '../pipeline/incremental';
import { DEFAULT_GOALS, GOAL_LIMITS, WHO_WEEK, fitGoal, sameGoals, type GoalLimit, type Goals } from '../pipeline/goals';
import { useGoalsControl } from '../hooks/useGoals';
import { useCycle } from '../hooks/useCycle';
import { useTheme } from '../hooks/useTheme';
import { THEMES, type Theme } from '../lib/theme';
import { SPANS, spanLabel } from '../ui/span';
import { Card, CardHead, DURATION_UNIT, fmtDuration, withUnits, type DomainKey } from '../ui/primitives';

// ─────────────────────────────────────────────────────────── section frame

/**
 * Whether a section fills a phone's screen of its own, opened from the Settings page's list. There its
 * name is the screen's heading and its card holds only the content; beside the list, on a wider
 * screen, it's an ordinary card with its name at the top.
 */
const ScreenContext = createContext(false);
export const SectionScreen = ScreenContext.Provider;
export const useSectionScreen = () => useContext(ScreenContext);

/**
 * In a section's own screen, the first row of a card's content has no rule above it: there's no
 * card heading to set it apart from.
 */
export const firstRuleOff = (screen: boolean) => (screen ? '[&>:first-child]:border-t-0' : '');

/** A Settings page section: a card with its name and hint, or, as its own screen, a heading over the card. */
export function SectionCard({ title, hint, right, domain, children }: {
  title: string;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  domain?: DomainKey;
  children: React.ReactNode;
}) {
  const screen = useSectionScreen();
  const heading = useRef<HTMLHeadingElement>(null);
  // A screen just opened starts at its name, for anyone following focus.
  useEffect(() => {
    if (screen) heading.current?.focus({ preventScroll: true });
  }, [screen]);

  if (!screen) {
    return (
      <Card>
        <CardHead title={title} hint={hint} right={right} domain={domain} />
        {children}
      </Card>
    );
  }
  return (
    <>
      <h2 ref={heading} tabIndex={-1} className="mt-1 font-display text-display text-zinc-50 outline-none">
        {title}
      </h2>
      {hint && <div className="mt-1 text-detail leading-relaxed text-zinc-400">{hint}</div>}
      {right && <div className="mt-3 text-caption text-zinc-500">{right}</div>}
      <Card className="mt-4 pt-2">{children}</Card>
    </>
  );
}

// ─────────────────────────────────────────────────────────── data facts

/**
 * What anyone needs to know to trust the numbers, in everyday words: no AI,
 * what "usual" means, the span things cover, how missing days are treated and
 * where the data is smoothed. Each figure comes from the constant it describes.
 */
export function DataFacts({ windowDays, windowFrom, historyFrom }: {
  windowDays: number;
  /** The window's first day: history older than this reaches the longer views. */
  windowFrom: CivilDate;
  historyFrom: CivilDate | null;
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
    <SectionCard title={t('data.facts.title')} hint={t('data.facts.hint')} domain="data">
      <ul className="px-5 pb-2">
        {facts.map(([id, lead, text], i) => (
          <li key={id} className={i ? 'py-3 border-t border-zinc-800/60' : 'pt-1 pb-3'}>
            <div className="text-body-sm font-medium text-zinc-200">{lead}</div>
            <p className="mt-0.5 text-caption leading-relaxed text-zinc-400">{text}</p>
          </li>
        ))}
      </ul>
    </SectionCard>
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
  const screen = useSectionScreen();
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
    <SectionCard
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
    >
      <div className={`px-5 pb-1.5 ${firstRuleOff(screen)}`}>
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
    </SectionCard>
  );
}

/**
 * Cycle tracking: off until the person turns it on, for anyone who has periods, whatever gender is
 * set. The log can be deleted on its own. Where the card is wide enough, its switches go two to a row.
 */
export function CycleCard({ kept }: {
  /** A log is kept on the server, though tracking is off and it wasn't sent. */
  kept: boolean;
}) {
  const { log, setSettings, forget, failed } = useCycle();
  const screen = useSectionScreen();
  const [deleteFailed, setDeleteFailed] = useState(false);
  const on = log.settings.tracking;
  const remove = async () => {
    if (!window.confirm(t('data.cycle.confirm'))) return;
    try {
      await forget();
      setDeleteFailed(false);
    } catch (err) {
      console.error('Failed to delete the cycle log:', err);
      setDeleteFailed(true);
    }
  };
  return (
    <SectionCard title={t('data.cycle.title')} hint={t('data.cycle.hint')} domain="cycle">
      <div className="@container px-5 pb-4">
        <div className={`grid grid-cols-1 @2xl:grid-cols-2 @2xl:gap-x-8 ${screen ? '[&>:first-child]:border-t-0 @2xl:[&>:nth-child(2)]:border-t-0' : ''}`}>
          <SwitchRow
            label={t('data.cycle.tracking')}
            note={t('data.cycle.trackingNote')}
            on={on}
            onToggle={() => setSettings({ ...log.settings, tracking: !on })}
          />
          {on && (
            <>
              <SwitchRow
                label={t('data.cycle.todayCards')}
                note={t('data.cycle.todayCardsNote')}
                on={log.settings.todayCards}
                onToggle={() => setSettings({ ...log.settings, todayCards: !log.settings.todayCards })}
              />
              <SwitchRow
                label={t('data.cycle.otherPages')}
                note={t('data.cycle.otherPagesNote')}
                on={log.settings.otherPages}
                onToggle={() => setSettings({ ...log.settings, otherPages: !log.settings.otherPages })}
              />
            </>
          )}
        </div>
        <div className="pt-3 border-t border-zinc-800/60 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p className="grow basis-64 text-caption leading-relaxed text-zinc-500">{on ? t('data.cycle.private') : t('data.cycle.off')}</p>
          {(on || kept || log.days.length > 0) && (
            <button
              type="button"
              onClick={remove}
              className="shrink-0 min-h-10 px-3.5 rounded-lg border border-rose-900/60 text-caption font-medium text-rose-300 hover:bg-rose-500/10 transition-colors"
            >
              {t('data.cycle.delete')}
            </button>
          )}
        </div>
        {failed && <p role="alert" className="mt-3 text-caption text-rose-400">{t('data.cycle.failed')}</p>}
        {deleteFailed && <p role="alert" className="mt-3 text-caption text-rose-400">{t('data.cycle.deleteFailed')}</p>}
      </div>
    </SectionCard>
  );
}

/** A setting that's on or off: its name, a line on what it does, and a switch. */
function SwitchRow({ label, note, on, onToggle }: { label: string; note: string; on: boolean; onToggle: () => void }) {
  const id = useId();
  return (
    <div className="py-3 border-t border-zinc-800/60 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div id={id} className="text-body text-zinc-200">{label}</div>
        <p className="mt-0.5 text-caption leading-relaxed text-zinc-500">{note}</p>
      </div>
      {/* Track and knob in the same units, so a browser's larger default text size scales both
          together, and the knob is centred by the track rather than placed by offsets. The
          ::before widens what a finger can hit to 44px tall. */}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={id}
        onClick={onToggle}
        className={`relative shrink-0 inline-flex items-center w-11 h-6 p-0.5 rounded-full transition-colors before:absolute before:-inset-x-1.5 before:-inset-y-2.5 before:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pink-300 ${on ? 'bg-pink-400' : 'bg-zinc-700 hover:bg-zinc-600'}`}
      >
        <span aria-hidden="true" className={`size-5 rounded-full bg-knob shadow-sm shadow-knob-shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </div>
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

// ─────────────────────────────────────────────────────────────── account

/**
 * How Healthier looks for the person, and their connection to Google Health: signing out, which
 * keeps their data here, and disconnecting, which deletes it. In demo mode, the way out of the demo.
 */
export function AccountCard({ email, demo, onSignOut, onDisconnect }: {
  email: string | null;
  demo: boolean;
  /** Signs out, or in demo mode leaves the demo. */
  onSignOut: () => void;
  /** Absent in demo mode, where there's nothing stored to delete. */
  onDisconnect?: () => void;
}) {
  const screen = useSectionScreen();
  const plain = 'shrink-0 min-h-10 px-3.5 rounded-lg border border-zinc-700 text-caption font-medium text-zinc-200 hover:bg-zinc-800 transition-colors';
  return (
    <SectionCard title={t('data.account.title')} hint={t('data.account.hint')}>
      <div className={`px-5 pb-2 ${firstRuleOff(screen)}`}>
        <ThemeRow demo={demo} />
        {demo ? (
          <AccountRow
            label={t('data.account.demo.label')}
            text={t('data.account.demo.text')}
            action={<button type="button" onClick={onSignOut} className={plain}>{t('data.account.demo.exit')}</button>}
          />
        ) : (
          <>
            <AccountRow
              label={t('data.account.google.label')}
              text={email ? t('data.account.google.connectedAs', { email }) : t('data.account.google.connected')}
              action={<button type="button" onClick={onSignOut} className={plain}>{t('data.account.google.signOut')}</button>}
            />
            {onDisconnect && (
              <AccountRow
                label={t('data.account.delete.label')}
                text={t('data.account.delete.text')}
                action={
                  <button
                    type="button"
                    onClick={onDisconnect}
                    className="shrink-0 min-h-10 px-3.5 rounded-lg border border-rose-900/60 text-caption font-medium text-rose-300 hover:bg-rose-500/10 transition-colors"
                  >
                    {t('data.account.delete.action')}
                  </button>
                }
              />
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}

const THEME_NAMES = {
  dark: 'data.account.theme.options.dark',
  light: 'data.account.theme.options.light',
  system: 'data.account.theme.options.system',
} as const satisfies Record<Theme, MessageKey>;

/**
 * The theme: dark, light, or the device's. A choice shows at once; signed in, it's saved with the
 * account. The options are radio buttons, so arrow keys move between them.
 */
function ThemeRow({ demo }: { demo: boolean }) {
  const { theme, choose, failed } = useTheme();
  const id = useId();
  return (
    <div className="py-3 border-t border-zinc-800/60">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 grow basis-64">
          <div id={id} className="text-body text-zinc-200">{t('data.account.theme.label')}</div>
          <p className="mt-0.5 text-caption leading-relaxed text-zinc-500">
            {t(demo ? 'data.account.theme.textDemo' : 'data.account.theme.text')}
          </p>
        </div>
        <div role="radiogroup" aria-labelledby={id} className="shrink-0 inline-flex p-0.5 rounded-lg border border-zinc-800 bg-zinc-950/80">
          {THEMES.map((option) => (
            <label
              key={option}
              className={`min-h-9 px-3 flex items-center rounded-md text-caption font-medium cursor-pointer transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-zinc-400 ${
                theme === option ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <input type="radio" name={id} value={option} checked={theme === option} onChange={() => choose(option)} className="sr-only" />
              {t(THEME_NAMES[option])}
            </label>
          ))}
        </div>
      </div>
      {failed && <p role="alert" className="mt-2 text-caption text-rose-400">{t('data.account.theme.failed')}</p>}
    </div>
  );
}

function AccountRow({ label, text, action }: { label: string; text: string; action: React.ReactNode }) {
  return (
    <div className="py-3 border-t border-zinc-800/60 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 grow basis-64">
        <div className="text-body text-zinc-200">{label}</div>
        <p className="mt-0.5 text-caption leading-relaxed text-zinc-500">{text}</p>
      </div>
      {action}
    </div>
  );
}
