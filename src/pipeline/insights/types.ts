export type Daypart = 'morning' | 'midday' | 'evening';

/** Where a card lives: Today, or one of the four pages with an insight carousel. */
export type Page = 'today' | 'activity' | 'sleep' | 'vitals' | 'body';
export type InsightPage = Exclude<Page, 'today'>;

/** What sort of card it is; the page carousels show it as an icon chip. */
export type Kind = 'alert' | 'nudge' | 'trend' | 'milestone' | 'pattern' | 'review' | 'data';

export type Tone = 'good' | 'watch' | 'neutral';

/** The data a card is about, for the page chip on Today. */
export type Domain = 'sleep' | 'movement' | 'cardio' | 'body' | 'data';

/** A card as the carousels show it. */
export interface Observation {
  /** Stable rule id, also the anchor back into the insight catalogue. */
  id: string;
  domain: Domain;
  page: Page;
  kind: Kind;
  tone: Tone;
  title: string;
  text: string;
  /** Optional suggestion, shown on its own line beneath the evidence. */
  action?: string;
  /** Which way a trend moved, so its chip points the same way. */
  direction?: 'up' | 'down';
}

/** What a rule found: the card, plus everything placement and the conflict rules need. */
export interface Finding extends Observation {
  /** 0–100: how much it matters. Sorts Today and breaks ties. */
  importance: number;
  /** One card per topic, across Today and the pages. */
  topic: string;
  /** Related cards. Inside a family, a cautious card beats good news. */
  family: string;
  /** When it may reach Today: for as long as it's true, only while it's news, or never. */
  today: 'while-true' | 'as-news' | 'never';
  /** The yesterday test says it started in the last couple of days, or it's a milestone or calendar day. */
  news: boolean;
  /** The parts of the day it belongs to on Today. Outside them it waits on its page, or doesn't show if it has none. */
  daypart?: Daypart[];
  /** What it says about a measure. Two cards never say opposite things about the same one. */
  claims?: { metric: string; direction: 'up' | 'down' | 'steady' };
  /** The advice it gives. A card that says push never shows beside one that says rest. */
  advice?: 'push' | 'rest';
  /** Days or readings behind it, to settle ties between opposite claims. */
  evidence?: number;
}

/** One evaluation, placed: each finding shows in exactly one carousel. */
export interface InsightFeeds {
  today: Observation[];
  pages: Record<InsightPage, Observation[]>;
}
