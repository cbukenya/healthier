import React, { useEffect, useId, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { t } from '../i18n';
import { HOME, useCustomization, type ActivityTab } from '../hooks/useCustomization';
import { useCycleTracking } from '../hooks/useCycle';
import { PAGE_LOOK, type PageId } from '../ui/pages';
import { Switch } from '../ui/Switch';
import { SectionCard, firstRuleOff, useSectionScreen } from './DataCards';
import { SECTION_TONE } from './sectionTones';

/**
 * Settings › Customization: the tabs in the bar, each with a switch to show it and a handle to drag
 * it into place, and the tab Activity opens on. Today is home, first and always shown: its switch
 * stays on, in grey. Cycle and
 * Nutrition are listed only while they'd be in the bar: with tracking on, and with food logged.
 */
export function CustomizeCard({ food }: { food: boolean }) {
  const c = useCustomization();
  const tracking = useCycleTracking();
  const screen = useSectionScreen();
  const pages = c.order.filter((p) => (p !== 'cycle' || tracking) && (p !== 'nutrition' || food));
  return (
    <SectionCard title={t('data.customize.title')} hint={t('data.customize.hint')}>
      <div className="px-5 pb-4">
        <TabList pages={pages} hidden={c.hidden} place={c.place} show={c.show} className={firstRuleOff(screen)} />
        <ActivityModeRow value={c.activityOpensOn} onChange={c.setActivityOpensOn} />
        <p className="pt-3 border-t border-zinc-800/60 text-caption leading-relaxed text-zinc-500">{t('data.customize.device')}</p>
      </div>
    </SectionCard>
  );
}

/** The keys that move a row, for assistive tech: key names, not words. */
const MOVE_KEYS = ['ArrowUp', 'ArrowDown'].join(' ');

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Drag {
  page: PageId;
  from: number;
  /** How far the pointer has moved since it took the handle. */
  dy: number;
  /** A row's height: one row's move. */
  h: number;
}

/**
 * The tabs, in order. A handle drags its row; the rows it passes step aside, and letting go puts it
 * there. With the keyboard, the handle's up and down arrows move it a row at a time.
 */
function TabList({ pages, hidden, place, show, className }: {
  pages: PageId[];
  hidden: Set<PageId>;
  place: (page: PageId, before: PageId | null) => void;
  show: (page: PageId, on: boolean) => void;
  className: string;
}) {
  const tone = SECTION_TONE.customize;
  const [drag, setDrag] = useState<Drag | null>(null);
  const last = pages.length - 1;
  const target = drag ? clamp(drag.from + Math.round(drag.dy / drag.h), 1, last) : -1;

  // A row moved with the keyboard keeps the focus on its handle.
  const handles = useRef(new Map<PageId, HTMLButtonElement>());
  const [moved, setMoved] = useState<PageId | null>(null);
  useEffect(() => {
    if (moved) handles.current.get(moved)?.focus();
  }, [moved, pages]);

  /** Moves `page`, now at `from`, to `to` among the rows shown. */
  const moveTo = (page: PageId, from: number, to: number) => {
    if (to === from) return;
    const rest = pages.filter((p) => p !== page);
    place(page, rest[to] ?? null);
  };

  const grab = (e: React.PointerEvent<HTMLButtonElement>, page: PageId, from: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const h = e.currentTarget.closest('li')?.getBoundingClientRect().height ?? 52;
    const y0 = e.clientY;
    let now: Drag = { page, from, dy: 0, h };
    setDrag(now);
    const move = (ev: PointerEvent) => {
      now = { ...now, dy: ev.clientY - y0 };
      setDrag(now);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      moveTo(page, from, clamp(from + Math.round(now.dy / h), 1, last));
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const key = (e: React.KeyboardEvent, page: PageId, from: number) => {
    const to = e.key === 'ArrowUp' ? from - 1 : e.key === 'ArrowDown' ? from + 1 : null;
    if (to === null) return;
    e.preventDefault();
    if (to < 1 || to > last) return;
    setMoved(page);
    moveTo(page, from, to);
  };

  /** Where a row sits while another is dragged: the dragged one under the pointer, the ones it passed a row over. */
  const offset = (i: number): number => {
    if (!drag) return 0;
    if (i === drag.from) return clamp(drag.dy, (1 - drag.from) * drag.h, (last - drag.from) * drag.h);
    if (drag.from < i && i <= target) return -drag.h;
    if (target <= i && i < drag.from) return drag.h;
    return 0;
  };

  return (
    <ul className={`${drag ? 'select-none' : ''} ${className}`}>
      {pages.map((p, i) => (
        <TabRow
          key={p}
          page={p}
          shown={p === HOME || !hidden.has(p)}
          offset={offset(i)}
          lifted={drag?.page === p}
          settling={!!drag}
          tone={tone}
          onShow={(on) => show(p, on)}
          handle={
            p === HOME ? null : (
              <button
                ref={(el) => {
                  if (el) handles.current.set(p, el);
                  else handles.current.delete(p);
                }}
                type="button"
                aria-label={t('data.customize.move', { page: t(PAGE_LOOK[p].label) })}
                aria-keyshortcuts={MOVE_KEYS}
                onPointerDown={(e) => grab(e, p, i)}
                onKeyDown={(e) => key(e, p, i)}
                onBlur={() => setMoved(null)}
                className={`-ml-2 size-9 shrink-0 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-300 touch-none cursor-grab active:cursor-grabbing focus-visible:outline-2 ${tone.focus}`}
              >
                <GripVertical size={16} aria-hidden="true" />
              </button>
            )
          }
        />
      ))}
    </ul>
  );
}

function TabRow({ page, shown, offset, lifted, settling, tone, onShow, handle }: {
  page: PageId;
  shown: boolean;
  offset: number;
  /** The row being dragged. */
  lifted: boolean;
  /** Another row is being dragged: this one slides aside as it passes. */
  settling: boolean;
  tone: { fill: string; focus: string };
  onShow: (on: boolean) => void;
  handle: React.ReactNode;
}) {
  const id = useId();
  const { label, icon: Icon, color } = PAGE_LOOK[page];
  const home = page === HOME;
  return (
    <li
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      className={`relative flex items-center gap-3 py-2 border-t border-zinc-800/60 ${
        lifted ? 'z-10 -mx-2 px-2 rounded-xl border-transparent bg-panel-raised shadow-lg shadow-black/30' : settling ? 'transition-transform duration-200 ease-out' : ''
      }`}
    >
      {handle ?? <span aria-hidden="true" className="-ml-2 size-9 shrink-0" />}
      <Icon size={18} aria-hidden="true" className={`shrink-0 ${shown ? color ?? 'text-zinc-300' : 'text-zinc-600'}`} />
      <span id={id} className={`flex-1 min-w-0 truncate text-body ${shown ? 'text-zinc-200' : 'text-zinc-500'}`}>{t(label)}</span>
      <Switch on={shown} onToggle={() => onShow(!shown)} tone={home ? { ...tone, fill: 'bg-zinc-600' } : tone} labelledBy={id} disabled={home} />
    </li>
  );
}

const ACTIVITY_TABS: { id: ActivityTab; label: 'workouts.tabs.steps' | 'workouts.tabs.workouts' }[] = [
  { id: 'steps', label: 'workouts.tabs.steps' },
  { id: 'workouts', label: 'workouts.tabs.workouts' },
];

/** The tab Activity opens on: Steps or Workouts, as radio buttons, so arrow keys move between them. */
function ActivityModeRow({ value, onChange }: { value: ActivityTab; onChange: (tab: ActivityTab) => void }) {
  const id = useId();
  return (
    <div className="py-3 border-t border-zinc-800/60 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 grow basis-64">
        <div id={id} className="text-body text-zinc-200">{t('data.customize.defaultActivityMode')}</div>
        <p className="mt-0.5 text-caption leading-relaxed text-zinc-500">{t('data.customize.activityModeNote')}</p>
      </div>
      <div role="radiogroup" aria-labelledby={id} className="shrink-0 inline-flex p-0.5 rounded-lg border border-zinc-800 bg-zinc-950/80">
        {ACTIVITY_TABS.map((option) => (
          <label
            key={option.id}
            className={`min-h-9 px-3 flex items-center rounded-md text-caption font-medium cursor-pointer transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-zinc-400 ${
              value === option.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <input type="radio" name={id} value={option.id} checked={value === option.id} onChange={() => onChange(option.id)} className="sr-only" />
            {t(option.label)}
          </label>
        ))}
      </div>
    </div>
  );
}
