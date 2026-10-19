import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';

/**
 * A panel over the page: a sheet from the bottom on a phone, a dialog in the middle on a wider
 * screen. Escape or the close button dismisses it, focus moves into it while it's open and goes
 * back where it was when it closes.
 */
export function Sheet({
  labelledBy,
  onClose,
  children,
}: {
  /** The id of the element that names it. */
  labelledBy: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      before?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end md:items-center justify-center">
      <div aria-hidden="true" className="absolute inset-0 bg-(--scrim)" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="relative w-full md:max-w-md max-h-[92vh] overflow-y-auto bg-zinc-900 border border-zinc-800 rounded-t-3xl md:rounded-3xl p-5 md:p-6 outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t('ui.sheet.close')}
          className="absolute top-4 right-4 size-11 flex items-center justify-center rounded-full bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
        >
          <X size={16} aria-hidden="true" />
        </button>
        {children}
      </div>
    </div>
  );
}

/** A choice of one or more, as a row of pills that say whether they're on. */
export function Chips<K extends string>({
  label,
  options,
  on,
  onToggle,
  tone = 'zinc',
}: {
  label: string;
  options: { id: K; label: string }[];
  on: (id: K) => boolean;
  onToggle: (id: K) => void;
  tone?: 'zinc' | 'pink';
}) {
  const active = tone === 'pink' ? 'border-pink-400 bg-pink-500/15 text-pink-100' : 'border-zinc-400 bg-zinc-800 text-zinc-50';
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={on(o.id)}
          onClick={() => onToggle(o.id)}
          className={`min-h-10 px-3.5 rounded-full border text-body-sm transition-colors ${
            on(o.id) ? `${active} font-semibold` : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
