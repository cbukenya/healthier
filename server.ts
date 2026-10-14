import express, { type ErrorRequestHandler } from 'express';
import path from 'path';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { ConfigError, loadConfig, type Config } from './server/config';
import { createDb, migrate, waitForDb } from './server/db';
import { authRoutes } from './server/auth';
import { apiRoutes } from './server/api';
import { startScheduler } from './server/sync';
import type { Deps } from './server/http';

dotenv.config({ quiet: true });

async function startServer(config: Config) {
  const db = createDb(config.databaseUrl);
  await waitForDb(db);
  await migrate(db);
  const deps: Deps = { config, db };

  const app = express();
  app.disable('x-powered-by');
  // gzip for the API and the app's files, for browsers that ask for it: the dataset is mostly
  // minute-level heart rate and shrinks about fivefold. Small responses are sent as they are.
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json());

  // Health probe for Docker and reverse proxies; fails when the database is unreachable.
  app.get('/healthz', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use(authRoutes(deps));
  app.use('/api', apiRoutes(deps));
  // Unknown API paths are errors, not the SPA's index.html.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  if (!config.isProduction) {
    // Imported lazily so the production server never loads Vite.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist', 'client');
    app.use(express.static(distPath));
    // Every other path is a client-side route. (Express 5 path syntax: a bare '*' no longer parses.)
    app.get('/{*path}', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const onError: ErrorRequestHandler = (err, req, res, next) => {
    console.error(`${req.method} ${req.path} failed:`, err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(onError);

  app.listen(config.port, "0.0.0.0", (err?: Error) => {
    // Express 5 reports listen failures (e.g. port in use) here instead of throwing.
    if (err) {
      console.error(`Cannot listen on port ${config.port}:`, err.message);
      process.exit(1);
    }
    console.log(`Server running on port ${config.port} (${config.appUrl})`);
  });
  startScheduler(deps);
}

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}
startServer(config).catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
