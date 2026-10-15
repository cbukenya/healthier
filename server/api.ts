import { Router } from 'express';
import type {
  CycleDayResponse, CycleLogResponse, CycleRejectedResponse, CycleSettingsResponse, DatasetResponse, GoalsResponse, HistoryResponse,
  InstanceResponse, MeResponse, ProfileResponse, SyncResponse,
} from '../src/types/api';
import { parseGoals } from '../src/pipeline/goals';
import { hasEntry, parseCycleDay, parseCycleSettings, withDay, withRejected } from '../src/pipeline/cycle';
import type { Gender } from '../src/pipeline/registry';
import { parseQueries } from '../src/pipeline/history';
import { requireUser, SESSION_COOKIE, sessionCookieOptions } from './auth';
import { revokeToken } from './google';
import { asyncHandler, type Deps } from './http';
import {
  deleteCycleLog, deleteUser, getCycleLog, getTokens, getUser, hasTokens, setGender, setGoals, setTimeZone, updateCycleLog,
} from './repo';
import { historyInfo, loadDataset, loadHistory, startSync, syncStatus } from './sync';

/** The browser's API. Every route after /instance acts on the signed-in user only. */
export function apiRoutes(deps: Deps): Router {
  const router = Router();

  /** What this install offers, for the sign-in screen: it's read before anyone has signed in. */
  router.get('/instance', (req, res) => {
    const body: InstanceResponse = { demo: deps.config.demoMode };
    res.json(body);
  });

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

  /** The whole cycle log: the dataset carries it only while tracking is on. */
  router.get(
    '/cycle',
    asyncHandler(async (req, res) => {
      const body: CycleLogResponse = { cycle: await getCycleLog(deps.db, deps.config.encryptionKey, res.locals.userId) };
      res.json(body);
    }),
  );

  /** Cycle tracking on or off, whether cycle cards may show on Today, and whether the other pages allow for the cycle. */
  router.put(
    '/cycle/settings',
    asyncHandler(async (req, res) => {
      const settings = parseCycleSettings(req.body?.settings);
      if (!settings) {
        res.status(400).json({ error: 'invalid_cycle_settings' });
        return;
      }
      await updateCycleLog(deps.db, deps.config.encryptionKey, res.locals.userId, (log) => ({ ...log, settings }));
      const body: CycleSettingsResponse = { settings };
      res.json(body);
    }),
  );

  /** One logged day: its flow, symptoms and note. A day sent with nothing on it is removed. */
  router.put(
    '/cycle/days/:date',
    asyncHandler(async (req, res) => {
      const day = parseCycleDay(req.params.date, req.body?.day ?? {});
      if (!day) {
        res.status(400).json({ error: 'invalid_cycle_day' });
        return;
      }
      await updateCycleLog(deps.db, deps.config.encryptionKey, res.locals.userId, (log) => withDay(log, day));
      const body: CycleDayResponse = { day: hasEntry(day) ? day : null };
      res.json(body);
    }),
  );

  /** A start found in the data that the person says wasn't a period, or that mark taken back. */
  router.put(
    '/cycle/rejected/:date',
    asyncHandler(async (req, res) => {
      const date = req.params.date;
      const rejected = req.body?.rejected;
      if (typeof date !== 'string' || !parseCycleDay(date, {}) || typeof rejected !== 'boolean') {
        res.status(400).json({ error: 'invalid_cycle_rejected' });
        return;
      }
      await updateCycleLog(deps.db, deps.config.encryptionKey, res.locals.userId, (log) => withRejected(log, date, rejected));
      const body: CycleRejectedResponse = { rejected };
      res.json(body);
    }),
  );

  /** Forget cycle tracking: the settings and every logged day. */
  router.delete(
    '/cycle',
    asyncHandler(async (req, res) => {
      await deleteCycleLog(deps.db, res.locals.userId);
      res.json({ ok: true });
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
