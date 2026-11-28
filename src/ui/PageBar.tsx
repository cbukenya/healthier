import React, { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

/**
 * The row at the top of every page, with the date on its right. A page can put its own controls at
 * its left, as Activity does its Steps and Workouts tabs, so they don't push the cards down a row.
 */
export const PageBarContext = createContext<HTMLElement | null>(null);

/** Puts its children on the page's top row, beside the date; in place, where there's no row. */
export function PageBar({ children }: { children: React.ReactNode }) {
  const slot = useContext(PageBarContext);
  return slot ? createPortal(children, slot) : <>{children}</>;
}
