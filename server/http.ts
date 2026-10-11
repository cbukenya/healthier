import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Config } from './config';
import type { Db } from './db';

/** What every route module needs, passed in rather than imported as globals. */
export interface Deps {
  config: Config;
  db: Db;
}

/** Express 4 ignores rejected promises; route them to the error handler instead. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
