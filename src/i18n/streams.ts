import { hasMessage, t } from '.';

/** The words for Google Health's data streams, which the server knows by their dataType. */

/**
 * A stream's name, from the `streams` section of the language file: "Resting heart rate" for
 * 'daily-resting-heart-rate'. A stream the file doesn't know keeps the name it came with, the
 * registry's English label.
 */
export function streamName(dataType: string, fallback: string): string {
  const key = `streams.${dataType}`;
  return hasMessage(key) ? t(key) : fallback;
}
