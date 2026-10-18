/**
 * Plain text split into runs, with the email addresses and web links in it marked as links:
 * for words an install's own settings provide, such as the sign-in screen's note, so they're
 * shown as text and never as markup.
 */
export interface TextRun {
  text: string;
  /** mailto: for an address, the address itself for a web link. */
  href?: string;
}

const LINK = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b|\bhttps?:\/\/[^\s<>"]+/gi;
/** Punctuation that ends a sentence rather than a link. */
const TRAILING = /[.,;:!?)\]'"]+$/;

export function linkify(text: string): TextRun[] {
  const out: TextRun[] = [];
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    let link = m[0];
    const tail = link.match(TRAILING)?.[0] ?? '';
    link = link.slice(0, link.length - tail.length);
    const start = m.index!;
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ text: link, href: link.includes('://') ? link : `mailto:${link}` });
    at = start + link.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
