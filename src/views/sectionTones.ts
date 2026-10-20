import type { SectionId } from './SettingsView';

/**
 * Each Settings page section's colour: the colour of its icon in the list, carried into the card it
 * opens, so a section's switches, choices and marks match the icon that opened it. Warnings keep
 * their own colours: amber for a stream that's behind, rose for one that failed or for deleting.
 */
export interface SectionTone {
  /** The icon's tile in the list. */
  tile: string;
  /** The list row of the section that's open, in the tile's lighter colour. */
  picked: string;
  /** An icon or a word in the section's colour. */
  text: string;
  /** A switch that's on, a dot that says all is well. */
  fill: string;
  /** A choice that's picked: its edge and its ground. */
  choice: string;
  /** The ring of a picked radio. */
  mark: string;
  /** The outline a control shows when it has the keyboard's focus. */
  focus: string;
}

const tone = {
  violet: {
    tile: 'bg-violet-400/12 text-violet-400', picked: 'bg-violet-400/8', text: 'text-violet-400', fill: 'bg-violet-400',
    choice: 'border-violet-400/50 bg-violet-400/8', mark: 'border-violet-400', focus: 'focus-visible:outline-violet-400',
  },
  sky: {
    tile: 'bg-sky-400/12 text-sky-400', picked: 'bg-sky-400/8', text: 'text-sky-400', fill: 'bg-sky-400',
    choice: 'border-sky-400/50 bg-sky-400/8', mark: 'border-sky-400', focus: 'focus-visible:outline-sky-400',
  },
  emerald: {
    tile: 'bg-emerald-400/12 text-emerald-400', picked: 'bg-emerald-400/8', text: 'text-emerald-400', fill: 'bg-emerald-400',
    choice: 'border-emerald-400/50 bg-emerald-400/8', mark: 'border-emerald-400', focus: 'focus-visible:outline-emerald-400',
  },
  pink: {
    tile: 'bg-pink-400/12 text-pink-400', picked: 'bg-pink-400/8', text: 'text-pink-400', fill: 'bg-pink-400',
    choice: 'border-pink-400/50 bg-pink-400/8', mark: 'border-pink-400', focus: 'focus-visible:outline-pink-400',
  },
  amber: {
    tile: 'bg-amber-400/12 text-amber-400', picked: 'bg-amber-400/8', text: 'text-amber-400', fill: 'bg-amber-400',
    choice: 'border-amber-400/50 bg-amber-400/8', mark: 'border-amber-400', focus: 'focus-visible:outline-amber-400',
  },
  zinc: {
    tile: 'bg-zinc-800 text-zinc-300', picked: 'bg-zinc-800/80', text: 'text-zinc-300', fill: 'bg-zinc-300',
    choice: 'border-zinc-600 bg-zinc-800/60', mark: 'border-zinc-300', focus: 'focus-visible:outline-zinc-400',
  },
} satisfies Record<string, SectionTone>;

export const SECTION_TONE: Record<SectionId, SectionTone> = {
  devices: tone.violet,
  streams: tone.sky,
  goals: tone.emerald,
  cycle: tone.pink,
  facts: tone.amber,
  account: tone.zinc,
};
