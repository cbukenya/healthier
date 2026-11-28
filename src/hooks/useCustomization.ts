import { readPref, usePrefsVersion, writePref } from '../lib/devicePrefs';
import { PAGES, type PageId } from '../ui/pages';

/**
 * Settings › Customization, kept on this device: which tabs show in the bar, their order, and the
 * tab Activity opens on. Today is home: always first, always shown.
 */

const PREF = { order: 'healthier.tabs.order', hidden: 'healthier.tabs.hidden', activity: 'healthier.activity.opensOn' } as const;

export const HOME: PageId = 'today';
const MOVABLE = PAGES.filter((p) => p !== HOME);

const ids = (key: string): PageId[] => {
  try {
    const list: unknown = JSON.parse(readPref(key) ?? '[]');
    return Array.isArray(list) ? list.filter((p): p is PageId => (MOVABLE as unknown[]).includes(p)) : [];
  } catch {
    return [];
  }
};

/** Every page, home first, then the others as ordered; a page added since the order was kept comes at the end. */
export function tabOrder(): PageId[] {
  const kept = [...new Set(ids(PREF.order))];
  return [HOME, ...kept, ...MOVABLE.filter((p) => !kept.includes(p))];
}

export const hiddenTabs = (): Set<PageId> => new Set(ids(PREF.hidden));

export type ActivityTab = 'steps' | 'workouts';
export const activityOpensOn = (): ActivityTab => (readPref(PREF.activity) === 'workouts' ? 'workouts' : 'steps');

/** The choices, and changing them. */
export function useCustomization() {
  usePrefsVersion();
  const order = tabOrder();
  const hidden = hiddenTabs();
  return {
    order,
    hidden,
    activityOpensOn: activityOpensOn(),
    /** Moves `page` to just before `before`, or to the end with null. */
    place(page: PageId, before: PageId | null) {
      if (page === HOME || before === HOME || page === before) return;
      const next = order.slice(1).filter((p) => p !== page);
      next.splice(before ? next.indexOf(before) : next.length, 0, page);
      writePref(PREF.order, JSON.stringify(next));
    },
    show(page: PageId, on: boolean) {
      if (page === HOME) return;
      const next = new Set(hidden);
      if (on) next.delete(page);
      else next.add(page);
      writePref(PREF.hidden, next.size ? JSON.stringify([...next]) : null);
    },
    setActivityOpensOn(tab: ActivityTab) {
      writePref(PREF.activity, tab === 'workouts' ? 'workouts' : null);
    },
  };
}
