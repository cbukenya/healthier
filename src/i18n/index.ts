import { IntlMessageFormat, type FormatXMLElementFn, type PrimitiveType } from 'intl-messageformat';
import enUS from '../locales/en-US.json';

/**
 * Every word the app shows comes from a language file: one JSON file per locale in src/locales,
 * laid out by where the words appear (tab → card → string). Messages are ICU MessageFormat, so
 * a language says its own plurals, word order and choices:
 *
 *   "nights": "{count, plural, one {# night} other {# nights}}"
 *
 * `t('sleep.debt.nights', { count })` formats one. Keys are checked against the English file
 * at compile time, and English is the fallback for anything another language leaves out.
 *
 * Call `t` where the words are used (in a component, or where an insight builds its sentence),
 * never at module scope: a module evaluates once, before the language is chosen.
 *
 * To add a language: copy en-US.json to, say, sv-SE.json, translate the values (never the keys),
 * and add it to LOCALES below. Tests check that it has every key English has, and no others.
 */

export type Messages = typeof enUS;

/** The languages the app speaks, by BCP 47 tag. */
const LOCALES = { 'en-US': enUS } satisfies Record<string, Messages>;

/**
 * English with every message in brackets, ⟦like this⟧, for checking that every word on screen
 * comes from the language file: anything outside brackets doesn't. Open the app with ?lang=en-XA.
 */
export const PSEUDO = 'en-XA';

export type Language = keyof typeof LOCALES;
export type Locale = Language | typeof PSEUDO;
export const DEFAULT_LOCALE: Language = 'en-US';
export const LANGUAGES = Object.keys(LOCALES) as Language[];

type Join<P extends string, K extends string> = P extends '' ? K : `${P}.${K}`;
type Paths<T, Leaf, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends Leaf
    ? Join<P, K>
    : T[K] extends string | readonly unknown[]
      ? never
      : Paths<T[K], Leaf, Join<P, K>>;
}[keyof T & string];

/** A message's key, such as 'vitals.heartRate.title'. */
export type MessageKey = Paths<Messages, string>;
/** A list's key, such as 'format.monthsShort'. */
export type ListKey = Paths<Messages, readonly string[]>;

export type Values = Record<string, PrimitiveType>;

type Compiled = { format: IntlMessageFormat; strip: Record<string, FormatXMLElementFn<unknown>> };

let active: Locale = DEFAULT_LOCALE;
let compiled = new Map<string, Compiled>();
let numbers = new Map<string, Intl.NumberFormat>();

/** Tests and development builds fail loudly on a missing value; production shows what it can. */
const STRICT = typeof window === 'undefined' || !!import.meta.env?.DEV;

const messages = (): unknown => (active === PSEUDO ? enUS : LOCALES[active]);
/** The tag Intl formats numbers and plurals with. */
const intlTag = () => (active === PSEUDO ? 'en' : active);

export const locale = (): Locale => active;

/** Switches language. Anything already on screen keeps its words until it renders again. */
export function setLocale(next: Locale): void {
  active = next;
  compiled = new Map();
  numbers = new Map();
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

/** The best of our languages for a browser's preferences: an exact match, then the same language. */
export function pickLocale(wanted: readonly string[]): Locale {
  const lower = (s: string) => s.toLowerCase();
  for (const w of wanted) {
    if (lower(w) === lower(PSEUDO)) return PSEUDO;
    const exact = LANGUAGES.find((l) => lower(l) === lower(w));
    if (exact) return exact;
    const same = LANGUAGES.find((l) => lower(l.split('-')[0]) === lower(w.split('-')[0]));
    if (same) return same;
  }
  return DEFAULT_LOCALE;
}

function lookup(root: unknown, key: string): unknown {
  let node = root;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Element types from the ICU parser, for walking a message's syntax tree. */
export const ICU = { literal: 0, argument: 1, number: 2, date: 3, time: 4, select: 5, plural: 6, pound: 7, tag: 8 } as const;

export type Element = {
  type: number;
  value?: unknown;
  children?: Element[];
  options?: Record<string, { value: Element[] }>;
};

/** The rich-text tags a message uses, such as <b>…</b>. */
function tagsOf(els: Element[], into = new Set<string>()): Set<string> {
  for (const el of els) {
    if (el.type === ICU.tag) {
      into.add(el.value as string);
      tagsOf(el.children ?? [], into);
    }
    if (el.options) for (const o of Object.values(el.options)) tagsOf(o.value, into);
  }
  return into;
}

function build(source: string, tag: string): Compiled {
  let format = new IntlMessageFormat(source, tag);
  if (active === PSEUDO) {
    const ast = [{ type: ICU.literal, value: '⟦' }, ...(format.getAst() as Element[]), { type: ICU.literal, value: '⟧' }];
    format = new IntlMessageFormat(ast as ReturnType<IntlMessageFormat['getAst']>, tag);
  }
  const strip: Compiled['strip'] = {};
  for (const name of tagsOf(format.getAst() as Element[])) strip[name] = (chunks) => chunks.join('');
  return { format, strip };
}

function compile(key: string): Compiled {
  let c = compiled.get(key);
  if (c) return c;
  const source = lookup(messages(), key) ?? lookup(enUS, key);
  if (typeof source !== 'string') throw new Error(`No message for ${key}`);
  c = build(source, intlTag());
  compiled.set(key, c);
  return c;
}

/**
 * A message with rich values: elements, or functions that wrap a tag's words. Returns a string
 * when everything was text. Components use `rich()` from ./react rather than this.
 *
 * A message that fails to format throws in tests and development. In production a translation
 * that fails falls back to the English message, and English that fails shows its key.
 */
export function formatParts<T>(
  key: MessageKey,
  values?: Record<string, PrimitiveType | T | FormatXMLElementFn<T>>,
): string | T | (string | T)[] {
  type All = Record<string, PrimitiveType | T | FormatXMLElementFn<T>>;
  try {
    const { format, strip } = compile(key);
    return format.format<T>({ ...strip, ...values } as All);
  } catch (err) {
    if (STRICT) throw err;
    console.error(err);
    const english = lookup(enUS, key);
    if (active !== DEFAULT_LOCALE && typeof english === 'string') {
      try {
        const { format, strip } = build(english, DEFAULT_LOCALE);
        return format.format<T>({ ...strip, ...values } as All);
      } catch {
        // English fails too: the key is all there is to show.
      }
    }
    return key;
  }
}

/** A message as plain text: rich-text tags are dropped and their words kept. */
export function t(key: MessageKey, values?: Values): string {
  const out = formatParts<string>(key, values);
  return Array.isArray(out) ? out.join('') : String(out);
}

/** Whether a key has a message, for keys put together at run time, such as a stream's name. */
export const hasMessage = (key: string): key is MessageKey => typeof lookup(enUS, key) === 'string';

/** A list from the language file, such as the names of the months. */
export function names(key: ListKey): readonly string[] {
  const list = lookup(messages(), key) ?? lookup(enUS, key);
  if (!Array.isArray(list)) throw new Error(`No list for ${key}`);
  return active === PSEUDO ? list.map((s) => `⟦${s}⟧`) : (list as string[]);
}

/** A number format for the active language, cached by its options. */
export function numberFormat(opts: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const id = JSON.stringify(opts);
  let f = numbers.get(id);
  if (!f) {
    f = new Intl.NumberFormat(intlTag(), opts);
    numbers.set(id, f);
  }
  return f;
}
