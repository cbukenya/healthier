import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { DEFAULT_THEME, lookOf, parseTheme, type Look, type Theme } from '../lib/theme';
import { useMediaQuery } from './useMediaQuery';
import type { ThemeResponse } from '../types/api';

/**
 * The theme for every screen (src/lib/theme.ts).
 *
 * Signed in, it's the one kept on the account; signed out, the one this device last showed. A
 * change shows at once and is saved straight away. If the save fails, the theme goes back to
 * how it was and the Account section says so. In demo mode a change lasts as long as the demo.
 */

/** Where the device keeps the last theme it showed, for index.html to open in. */
const STORAGE_KEY = 'healthier.theme';

const remembered = (): Theme | null => {
  try {
    return parseTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
};

const remember = (theme: Theme) => {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // A browser that keeps nothing opens in the default until the account says otherwise.
  }
};

/** Draws the page in a look, and gives the browser's bar, and an installed app's, the page's colour. */
function show(look: Look) {
  const root = document.documentElement;
  root.dataset.theme = look;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).backgroundColor);
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content', look === 'light' ? 'default' : 'black');
}

interface ThemeContextValue {
  theme: Theme;
  /** What the page is drawn in now. */
  look: Look;
  choose: (theme: Theme) => void;
  /** The last choice couldn't be saved, so it was undone. */
  failed: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  look: 'dark',
  choose: () => {},
  failed: false,
});

export function ThemeProvider({ saved, demo, children }: {
  /** The account's theme: null when the person hasn't picked one, undefined when no one is signed in. */
  saved: Theme | null | undefined;
  demo: boolean;
  children: React.ReactNode;
}) {
  const signedIn = saved !== undefined && !demo;
  const base = signedIn ? (saved ?? DEFAULT_THEME) : (remembered() ?? DEFAULT_THEME);
  // A choice made since the account's theme arrived, or since the demo began; until then, the base.
  const [chosen, setChosen] = useState<Theme | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setChosen(null);
    setFailed(false);
  }, [saved, demo]);

  // The device opens in the account's theme next time, before it has heard from the server.
  useEffect(() => {
    if (signedIn) remember(saved ?? DEFAULT_THEME);
  }, [signedIn, saved]);

  const theme = chosen ?? base;
  const light = useMediaQuery('(prefers-color-scheme: light)');
  const look = lookOf(theme, light);
  useLayoutEffect(() => show(look), [look]);

  const choose = useCallback(
    (next: Theme) => {
      const before = theme;
      setChosen(next);
      setFailed(false);
      if (!signedIn) return;
      remember(next);
      api<ThemeResponse>('/api/theme', { method: 'PUT', body: { theme: next } }).catch((err) => {
        console.error('Failed to save the theme:', err);
        setChosen(before);
        remember(before);
        setFailed(true);
      });
    },
    [theme, signedIn],
  );

  const value = useMemo(() => ({ theme, look, choose, failed }), [theme, look, choose, failed]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The theme, what it comes to here, and the way to change it. */
export const useTheme = () => useContext(ThemeContext);
