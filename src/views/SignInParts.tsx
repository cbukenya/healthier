import React, { useCallback, useId, useState } from 'react';
import { Info } from 'lucide-react';
import { t } from '../i18n';
import { linkify } from '../lib/linkify';
import { Sheet } from '../ui/Sheet';

/**
 * The sign-in card's info button and what it opens: how Healthier uses the data it reads, and that
 * it's for general wellness only. Google asks for this disclosure in the app itself for the Health
 * API's restricted scopes, so it stays one tap from the sign-in screen.
 */
export function AboutYourData() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const titleId = useId();
  return (
    <>
      <button
        type="button"
        aria-label={t('app.signIn.about')}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="absolute top-4 right-4 size-11 flex items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
      >
        <Info size={18} aria-hidden="true" />
      </button>
      {open && (
        <Sheet labelledBy={titleId} onClose={close}>
          <h2 id={titleId} className="pr-12 font-display text-headline text-zinc-50">{t('app.signIn.about')}</h2>
          <p className="mt-3 text-body-sm leading-relaxed text-zinc-300">{t('app.signIn.disclosure')}</p>
          <p className="mt-3 text-detail leading-relaxed text-zinc-500">{t('app.signIn.wellness')}</p>
        </Sheet>
      )}
    </>
  );
}

/** The install's own note under the sign-in buttons (SIGN_IN_NOTE): its words as text, its addresses and links as links. */
export function SignInNote({ note }: { note: string }) {
  return (
    <p className="mt-6 pt-5 border-t border-zinc-800 text-detail leading-relaxed text-zinc-400">
      {linkify(note).map((run, i) => {
        // A web link opens beside the sign-in screen; an address opens the mail app.
        const web = !!run.href && !run.href.startsWith('mailto:');
        return run.href ? (
          <a
            key={i}
            href={run.href}
            target={web ? '_blank' : undefined}
            rel={web ? 'noopener noreferrer' : undefined}
            className="text-zinc-200 underline decoration-zinc-600 underline-offset-2 hover:decoration-zinc-300"
          >
            {run.text}
          </a>
        ) : (
          <React.Fragment key={i}>{run.text}</React.Fragment>
        );
      })}
    </p>
  );
}
