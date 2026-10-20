/**
 * How Healthier looks for a person: dark, light, or whichever their device is set to.
 *
 * Dark until they pick another on the Settings page's Account section. The choice is kept on their
 * account, so it follows them to every device, and on the device too, so the page opens in it
 * before anything else has loaded (index.html).
 */
export const THEMES = ['dark', 'light', 'system'] as const;

export type Theme = (typeof THEMES)[number];

/** What a page is drawn in: a theme of `system` comes to one of these on each device. */
export type Look = 'dark' | 'light';

export const DEFAULT_THEME: Theme = 'dark';

export const parseTheme = (raw: unknown): Theme | null => (THEMES.includes(raw as Theme) ? (raw as Theme) : null);

/** The look a theme comes to, on a device set to light (`light`) or not. */
export const lookOf = (theme: Theme, light: boolean): Look => (theme === 'system' ? (light ? 'light' : 'dark') : theme);
