import { useSyncExternalStore } from 'react';

/**
 * Choices kept on this device only, in the browser's storage: Accessibility's and Customization's.
 * Where storage is blocked (some private windows), a choice is held in memory until the page reloads.
 */

const memory = new Map<string, string>();

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

const listeners = new Set<() => void>();
let version = 0;

/** Keeps a choice, or forgets it with null, and tells everything showing one. */
export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
  version++;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Draws the component again whenever a choice on this device changes. */
export function usePrefsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}
