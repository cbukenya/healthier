import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ApiUser, MeResponse } from '../types/api';

/**
 * Who is signed in, according to the server.
 *
 * Sign-in is a full-page redirect through Google's consent screen; the server
 * keeps the tokens and hands the browser only an httpOnly session cookie, so
 * nothing here ever sees a Google token.
 */
export function useAuth() {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    try {
      const me = await api<MeResponse>('/api/me');
      setUser(me.user);
      setNeedsReconnect(me.needsReconnect);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error('Failed to load session:', err);
      setUser(null);
      setNeedsReconnect(false);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const signIn = useCallback(() => {
    // Reconnecting must force Google's consent screen, or no new refresh token is issued.
    window.location.href = needsReconnect ? '/auth/google?consent=1' : '/auth/google';
  }, [needsReconnect]);

  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch((err) => console.error('Sign-out failed:', err));
    setUser(null);
    setNeedsReconnect(false);
  }, []);

  /** Revoke Google access and delete everything the server stores about this user. */
  const deleteAccount = useCallback(async () => {
    await api('/api/me', { method: 'DELETE' });
    setUser(null);
    setNeedsReconnect(false);
  }, []);

  return { user, needsReconnect, ready, signIn, signOut, deleteAccount, reload };
}
