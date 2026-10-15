import { Fragment, isValidElement, type ReactNode } from 'react';
import type { PrimitiveType } from 'intl-messageformat';
import { formatParts, type MessageKey } from '.';

/** A tag's words, wrapped: `b: (words) => <b>{words}</b>`. */
export type Wrap = (words: ReactNode[]) => ReactNode;

const keyed = (nodes: ReactNode[]) => nodes.map((n, i) => (isValidElement(n) ? <Fragment key={i}>{n}</Fragment> : n));

/**
 * A message with styled words or elements in it. Tags in the message wrap words, and values may
 * be elements as well as text:
 *
 *   "zones": "<light>Light</light> minutes accumulate from daily life"
 *   rich('activity.mix.note', { light: (w) => <span className="text-emerald-400">{w}</span> })
 *
 * Tags left without a wrapper keep their words, unstyled.
 */
export function rich(key: MessageKey, values: Record<string, PrimitiveType | ReactNode | Wrap> = {}): ReactNode {
  const wrapped: Record<string, PrimitiveType | ReactNode | Wrap> = {};
  for (const [name, v] of Object.entries(values)) {
    wrapped[name] = typeof v === 'function' ? (words: ReactNode[]) => (v as Wrap)(keyed(words)) : v;
  }
  const out = formatParts<ReactNode>(key, wrapped as Parameters<typeof formatParts<ReactNode>>[1]);
  return Array.isArray(out) ? keyed(out) : out;
}
