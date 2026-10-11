import { Router } from 'express';
import type { DatasetResponse, MeResponse, SyncResponse } from '../src/types/api';
import { requireUser, SESSION_COOKIE, sessionCookieOptions } from './auth';
import { revokeToken } from './google';
import { asyncHandler, type Deps } from './http';
import { deleteUser, getTokens, getUser, hasTokens, setTimeZone } from './repo';
import { loadDataset, startSync, syncStatus } from './sync';

/** The browser's API. Every route acts on the signed-in user only. */
export function apiRoutes(deps: Deps): Router {
  const router = Router();
  router.use(requireUser(deps));

  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      const userId: string = res.locals.userId;
      const user = await getUser(deps.db, userId);
      if (!user) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      const body: MeResponse = {
        user: { id: user.id, name: user.name, email: user.email, pictureUrl: user.pictureUrl },
        needsReconnect: !(await hasTokens(deps.db, userId)),
      };
      res.json(body);
    }),
  );

  /** Disconnect Google and delete everything stored about the user. */
  router.delete(
    '/me',
    asyncHandler(async (req, res) => {
      const userId: string = res.locals.userId;
      const tokens = await getTokens(deps.db, deps.config.encryptionKey, userId).catch(() => null);
      if (tokens) await revokeToken(tokens.refreshToken);
      await deleteUser(deps.db, userId);
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions(deps));
      res.json({ ok: true });
    }),
  );

  router.get(
    '/dataset',
    asyncHandler(async (req, res) => {
      const userId: string = res.locals.userId;
      const stored = await loadDataset(deps, userId);
      const body: DatasetResponse = {
        dataset: stored?.dataset ?? null,
        syncedAt: stored?.syncedAt.toISOString() ?? null,
        sync: syncStatus(userId),
      };
      res.json(body);
    }),
  );

  router.get('/sync', (req, res) => {
    const body: SyncResponse = { sync: syncStatus(res.locals.userId) };
    res.json(body);
  });

  /** Start a sync (or join the running one); `full` refetches the whole window. Poll GET /sync for progress. */
  router.post(
    '/sync',
    asyncHandler(async (req, res) => {
      const userId: string = res.locals.userId;
      const timeZone = req.body?.timeZone;
      if (typeof timeZone === 'string' && isTimeZone(timeZone)) await setTimeZone(deps.db, userId, timeZone);
      const body: SyncResponse = { sync: startSync(deps, userId, { full: req.body?.full === true }).status };
      res.status(202).json(body);
    }),
  );

  return router;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
