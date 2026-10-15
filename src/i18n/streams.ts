import type { StreamReport } from '../types/health';
import { hasMessage, t } from '.';

/**
 * The words for Google Health's data streams. The server knows a stream by its dataType and sends
 * codes for the errors it names; these say both in the person's language.
 */

/**
 * A stream's name, from the `streams` section of the language file: "Resting heart rate" for
 * 'daily-resting-heart-rate'. A stream the file doesn't know keeps the name it came with, the
 * registry's English label.
 */
export function streamName(dataType: string, fallback: string): string {
  const key = `streams.${dataType}`;
  return hasMessage(key) ? t(key) : fallback;
}

/**
 * What went wrong on a stream's last fetch: Google's words (or the network's) as they came, or
 * Healthier's own for an error it names with a code. A report stored before codes holds English
 * of ours in `error`; it shows as it is.
 */
export function streamError(r: Pick<StreamReport, 'error' | 'errorCode'>): string | undefined {
  switch (r.errorCode) {
    case 'http':
      return t('data.streams.errors.http', { status: r.error ?? '' });
    case 'network':
      return t('data.streams.errors.network');
    case 'truncated':
      return t('data.streams.errors.truncated');
    default:
      return r.error;
  }
}
