import type { SyncFailure } from '../hooks/useHealth';
import { t } from '.';
import { streamError } from './streams';

/** Why the sync failed, in words: a reason the app can name, or the failure's own words when it can't. */
export function failureText(f: SyncFailure): string {
  switch (f.code) {
    case 'rejected':
      return t('app.syncFailed.reasons.rejected', { detail: streamError(f.detail) ?? '' });
    case 'reconnect':
      return t('app.syncFailed.reasons.reconnect');
    case 'tokenRefresh':
      return t('app.syncFailed.reasons.tokenRefresh', { status: f.status });
    case 'request':
      return t('app.syncFailed.reasons.request', { status: f.status });
    case 'noData':
      return t('app.syncFailed.reasons.noData');
    case 'unknown':
      return t('app.syncFailed.reasons.unknown');
    case 'other':
      return f.detail;
  }
}
