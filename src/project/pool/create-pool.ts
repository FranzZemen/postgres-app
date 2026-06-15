/*
Created by Franz Zemen
License Type: UNLICENSED
*/

import {Pool, type PoolConfig} from 'pg';
import {ExecutionContext} from '@franzzemen/execution-context';
import {LoggerApi} from '@franzzemen/logger';
import type {PostgresAppConfig} from '../config-loader/types.js';

/**
 * Create a pg.Pool wired for Aurora IAM auth and SSL.
 *
 * IAM token strategy: pg invokes `password` as a function on every new
 * physical connection. The callback delegates to `config.rds.tokenFn()`,
 * which mints a fresh short-lived (~15 min TTL) IAM token. `idleTimeoutMillis`
 * (default 10 min) caps connection lifetime so connections roll over inside
 * the token window — no proactive refresh, no token cache.
 *
 * SSL: server CA pinned via `config.rds.caBundle` (the AWS RDS global bundle).
 *
 * Caller owns the returned pool and is responsible for `pool.end()` at
 * process shutdown.
 *
 * @iam rds-db:connect (checked at PG connect time, not here)
 */
export function createPool(
  ec: ExecutionContext,
  config: PostgresAppConfig,
): Pool {
  const log = new LoggerApi(ec, 'postgres-app', 'pool', 'createPool');

  const pgConfig: PoolConfig = {
    host: config.rds.endpoint,
    port: config.rds.port,
    database: config.rds.database,
    user: config.rds.user,
    // Function form — pg invokes per new connection. Returns a fresh IAM token.
    password: async () => config.rds.tokenFn(),
    ssl: {
      ca: config.rds.caBundle,
      rejectUnauthorized: true,
    },
    min: config.pool.min,
    max: config.pool.max,
    idleTimeoutMillis: config.pool.idleTimeoutMillis,
    connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
    // Server-side backstops (pg passes these to each connection). A stuck/aborted
    // idle-in-transaction connection or a runaway statement is force-terminated by
    // Postgres, freeing it back to the budget. 0 = disabled.
    ...(config.pool.idleInTransactionSessionTimeoutMillis > 0
      ? {idle_in_transaction_session_timeout: config.pool.idleInTransactionSessionTimeoutMillis}
      : {}),
    ...(config.pool.statementTimeoutMillis > 0
      ? {statement_timeout: config.pool.statementTimeoutMillis}
      : {}),
  };

  const pool = new Pool(pgConfig);

  pool.on('error', (err) => {
    log.error({err}, 'pg pool emitted error');
  });

  log.debug(
    {
      host: config.rds.endpoint,
      database: config.rds.database,
      user: config.rds.user,
      pool: config.pool,
    },
    'pg pool created',
  );

  return pool;
}
