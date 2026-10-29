import React, { useCallback, useId, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { t } from '../i18n';
import { rich } from '../i18n/react';
import { linkify } from '../lib/linkify';
import { Sheet } from '../ui/Sheet';

/** How Healthier uses the data it reads, a point at a time. */
const DATA_POINTS = ['reads', 'uses', 'keeps', 'delete'] as const;

const LINK = 'text-zinc-200 underline decoration-zinc-600 underline-offset-2 hover:decoration-zinc-300';

/** A web link on the sign-in screen: it opens beside it, so the screen stays where it was. */
function WebLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
      {children}
    </a>
  );
}

/**
 * The sign-in card's info button and what it opens: how Healthier uses the data it reads, the
 * install's privacy notice if it has one, and that it's for general wellness only. Google asks for
 * this disclosure in the app itself for the Health API's restricted scopes, so it stays one tap
 * from the sign-in screen.
 */
export function AboutYourData({ privacy }: { privacy: string | null }) {
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
          <ul className="mt-4 space-y-3 text-body-sm leading-relaxed text-zinc-300">
            {DATA_POINTS.map((point) => (
              <li key={point} className="flex gap-3">
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-zinc-500" />
                {t(`app.signIn.data.${point}`)}
              </li>
            ))}
          </ul>
          {privacy && (
            <p className="mt-4 text-body-sm">
              <WebLink href={privacy}>{t('app.signIn.data.privacy')}</WebLink>
            </p>
          )}
          <p className="mt-4 pt-4 border-t border-zinc-800 text-detail leading-relaxed text-zinc-500">{t('app.signIn.wellness')}</p>
        </Sheet>
      )}
    </>
  );
}

/**
 * Under the sign-in buttons, when the install has them (TERMS_URL, PRIVACY_URL): connecting means
 * accepting its terms and privacy notice, each a link.
 */
export function SignInConsent({ terms, privacy }: { terms: string | null; privacy: string | null }) {
  if (!terms && !privacy) return null;
  const key = terms && privacy ? 'app.signIn.consent.both' : terms ? 'app.signIn.consent.terms' : 'app.signIn.consent.privacy';
  return (
    <p className="mt-4 text-detail leading-relaxed text-zinc-500">
      {rich(key, {
        terms: (words) => (terms ? <WebLink href={terms}>{words}</WebLink> : words),
        privacy: (words) => (privacy ? <WebLink href={privacy}>{words}</WebLink> : words),
      })}
    </p>
  );
}

/** The install's own note under the sign-in buttons (SIGN_IN_NOTE): its words as text, its addresses and links as links. */
export function SignInNote({ note }: { note: string }) {
  return (
    <p className="mt-6 pt-5 border-t border-zinc-800 text-detail leading-relaxed text-zinc-400">
      {linkify(note).map((run, i) => {
        if (!run.href) return <React.Fragment key={i}>{run.text}</React.Fragment>;
        // A web link opens beside the sign-in screen; an address opens the mail app.
        return run.href.startsWith('mailto:') ? (
          <a key={i} href={run.href} className={LINK}>
            {run.text}
          </a>
        ) : (
          <WebLink key={i} href={run.href}>
            {run.text}
          </WebLink>
        );
      })}
    </p>
  );
}

/** Google's "G", in its own colours, as Google's sign-in branding asks: on a white button, left of the words. */
export function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 48 48" className="shrink-0">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
