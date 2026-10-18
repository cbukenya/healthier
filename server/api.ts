import { Router } from 'express';
import type {
  CycleDayResponse, CycleLogResponse, CycleRejectedResponse, CycleSettingsResponse, DatasetResponse, GoalsResponse, HistoryResponse,
  InstanceResponse, MeResponse, ProfileResponse, SourcesResponse, SyncResponse,
} from '../src/types/api';
import { parseGoals } from '../src/pipeline/goals';
import { parseSourcePrefs, readSourcePrefs } from '../src/pipeline/sources';
import { hasEntry, parseCycleDay, parseCycleSettings, withDay, withRejected } from '../src/pipeline/cycle';
import { SLEEP_HR_FLOOR } from '../src/pipeline/registry';
import type { Gender } from '../src/pipeline/registry';
import { parseQueries } from '../src/pipeline/history';
import { requireUser, SESSION_COOKIE, sessionCookieOptions } from './auth';
import { revokeToken } from './google';
import { asyncHandler, type Deps } from './http';
import {
  deleteCycleLog,
  purgeStream, deleteUser, getCycleLog, getTokens, getUser, hasTokens, setGender, setGoals, setSourcePrefs, setTimeZone, updateCycleLog,
} from './repo';
import { describeSources, followSourceChoice, historyInfo, loadDataset, loadHistory, refetchTotals, startSync, syncStatus } from './sync';

/** The browser's API. Every route after /instance acts on the signed-in user only. */
export function apiRoutes(deps: Deps): Router {
  const router = Router();

  /** What this install offers, for the sign-in screen: it's read before anyone has signed in. */
  router.get('/instance', (req, res) => {
    const body: InstanceResponse = { demo: deps.config.demoMode, note: deps.config.signInNote };
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

  /** The person's devices and apps, and their choices of which count and which comes first (pipeline/sources.ts). */
  router.get(
    '/sources',
    asyncHandler(async (req, res) => {
      const described = await describeSources(deps, res.locals.userId);
      if (!described) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const body: SourcesResponse = { ...described, refetching: false };
      res.json(body);
    }),
  );

  /**
   * New choices. Readings are picked when they're read, so a choice of device takes effect at once;
   * daily totals and minute heart rate come added up by Google, so a new choice of what counts in
   * them clears those and fetches them again.
   */
  router.put(
    '/sources',
    asyncHandler(async (req, res) => {
      const userId: string = res.locals.userId;
      const prefs = parseSourcePrefs(req.body?.prefs);
      const user = await getUser(deps.db, userId);
      if (!prefs || !user) {
        res.status(400).json({ error: 'invalid_sources' });
        return;
      }
      const before = readSourcePrefs(user.sources);
      await setSourcePrefs(deps.db, userId, prefs);
      const refetching = prefs.totals !== before.totals;
      if (refetching) await refetchTotals(deps, userId);
      else await followSourceChoice(deps, userId, user.timeZone);
      const described = await describeSources(deps, userId);
      const body: SourcesResponse = { ...described!, refetching };
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
      let wasTracking = false;
      await updateCycleLog(deps.db, deps.config.encryptionKey, res.locals.userId, (log) => {
        wasTracking = log.settings.tracking;
        return { ...log, settings };
      });
      // The night's heart rate floor is kept for cycle tracking alone: a sync computes it and
      // fills its history as soon as tracking goes on, and it goes as soon as tracking goes off.
      if (settings.tracking && !wasTracking) startSync(deps, res.locals.userId);
      if (!settings.tracking && wasTracking) await purgeStream(deps.db, res.locals.userId, SLEEP_HR_FLOOR.dataType);
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
      await purgeStream(deps.db, res.locals.userId, SLEEP_HR_FLOOR.dataType);
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
