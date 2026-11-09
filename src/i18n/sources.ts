import { parseSource } from '../pipeline/normalize';
import type { SourceRef } from '../types/health';
import { hasMessage, t } from '.';

/** What's needed of a source to name it: a stored SourceRef, or the card's SourceSummary. */
type Named = Pick<SourceRef, 'label' | 'platform' | 'app' | 'formFactor'>;

/**
 * A source known by its platform alone, with no device or app named: on FITBIT, what the Google
 * Health app works out or is given by hand (cardio fitness, heart rate zones, weight), stored under
 * the platform's English name ("Fitbit").
 */
export function isPlatformOnly(src: Named): boolean {
  return !src.app && !src.formFactor && src.platform !== 'UNKNOWN' && src.label === parseSource({ platform: src.platform })?.label;
}

/**
 * What a source is called: a device's or app's own name, as it came. Where Healthier stored an
 * English word for want of one, the language file names it: a device Google knows only by its kind
 * ("WATCH", stored as "Watch"), a platform's own app ("Fitbit", the Google Health app), and a
 * source Google says nothing about ("Unknown").
 */
export function sourceName(src: Named): string {
  if (src.app) return src.label;
  const kind = src.formFactor;
  if (kind) {
    // The label normalize.ts stores for a source it knows only by this kind.
    if (src.label !== parseSource({ device: { formFactor: kind } })?.label) return src.label;
    const key = `data.streams.formFactors.${kind.toUpperCase()}`;
    return hasMessage(key) ? t(key) : src.label;
  }
  if (isPlatformOnly(src)) {
    const key = `data.sources.platformOnly.${src.platform}`;
    return hasMessage(key) ? t(key) : src.label;
  }
  return src.platform === 'UNKNOWN' && src.label === parseSource({})?.label ? t('data.streams.unknownSource') : src.label;
}
