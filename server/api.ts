import { Router } from 'express';
import type { DatasetResponse, GoalsResponse, HistoryResponse, MeResponse, ProfileResponse, SyncResponse } from '../src/types/api';
import { parseGoals } from '../src/pipeline/goals';
import type { Gender } from '../src/pipeline/registry';
import { parseQueries } from '../src/pipeline/history';
import { requireUser, SESSION_COOKIE, sessionCookieOptions } from './auth';
import { revokeToken } from './google';
import { asyncHandler, type Deps } from './http';
import { deleteUser, getTokens, getUser, hasTokens, setGender, setGoals, setTimeZone } from './repo';
import { historyInfo, loadDataset, loadHistory, startSync, syncStatus } from './sync';

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

  /** What the person sets about themselves; for now their gender, which Google Health doesn't provide. */
  router.put(
    '/profile',
    asyncHandler(async (req, res) => {
      const gender = req.body?.gender ?? null;
      if (gender !== null && !GENDERS.includes(gender)) {
        res.status(400).json({ error: 'invalid_gender' });
        return;
      }
      await setGender(deps.db, res.locals.userId, gender);
      const body: ProfileResponse = { gender };
      res.json(body);
    }),
  );

  /** The person's goals, set on the Data tab. Each must sit inside its bounds (GOAL_LIMITS). */
  router.put(
    '/goals',
    asyncHandler(async (req, res) => {
      const goals = parseGoals(req.body?.goals);
      if (!goals) {
        res.status(400).json({ error: 'invalid_goals' });
        return;
      }
      await setGoals(deps.db, res.locals.userId, goals);
      const body: GoalsResponse = { goals };
      res.json(body);
    }),
  );

  /** The dashboard's dataset. POST it with `queries` to have history questions answered alongside. */
  const dataset = asyncHandler(async (req, res) => {
    const userId: string = res.locals.userId;
    const stored = await loadDataset(deps, userId, parseQueries(req.body?.queries));
    const body: DatasetResponse = {
      dataset: stored?.dataset ?? null,
      syncedAt: stored?.syncedAt.toISOString() ?? null,
      history: stored?.history ?? null,
      sync: syncStatus(userId),
    };
    res.json(body);
  });
  router.get('/dataset', dataset);
  router.post('/dataset', dataset);

  /** Long-span history for the 90d / 1y / All views; fetched only when one is chosen. */
  router.get(
    '/history',
    asyncHandler(async (req, res) => {
      const days = await loadHistory(deps, res.locals.userId);
      const body: HistoryResponse = { days: days ?? [] };
      res.json(body);
    }),
  );

  router.get(
    '/sync',
    asyncHandler(async (req, res) => {
      const userId: string = res.locals.userId;
      const body: SyncResponse = { sync: syncStatus(userId), history: await historyInfo(deps, userId) };
      res.json(body);
    }),
  );

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

const GENDERS: Gender[] = ['female', 'male', 'other'];

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
