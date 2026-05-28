/*
Created by Franz Zemen
License Type: UNLICENSED
*/

import {ExecutionContext} from '@franzzemen/execution-context';
import {LoggerApi} from '@franzzemen/logger';
import {Rds} from '@franzzemen/aws-app/rds';
import type {AWSIniProfile} from '@franzzemen/aws-app/context';
import {postgresContextKey, type PostgresContext, type PostgresAppConfig} from './types.js';

/**
 * Default pool sizing — keep `min: 0` to play well with Aurora scale-to-zero;
 * keep `idleTimeoutMillis: 600_000` (10 min) comfortably inside the 15-min
 * IAM auth token TTL so connections roll over before tokens expire.
 */
const DEFAULT_POOL = {
  min: 0,
  max: 10,
  idleTimeoutMillis: 600_000,
  connectionTimeoutMillis: 5_000,
} as const;

/**
 * Resolve the postgres-app configuration for the current process.
 *
 * 1. Reads `process.env.BROKENSTOCK_DB` to determine which database this
 *    process is pinned to. Throws if unset (per the single-DB-per-process
 *    discipline — each worker process serves exactly one database).
 * 2. Calls `aws-app/rds`'s `Rds.resolveConnectionConfig(BROKENSTOCK_DB)` to
 *    pull endpoint, port, database name, IAM user, region, SSL CA bundle,
 *    and a token-mint callback. Connection details live under `aws.rds.*`,
 *    not in the postgres-app block.
 * 3. Loads pool sizing from the optional `postgres.pool` block in
 *    ExecutionContext (defaults filled in for any missing keys).
 *
 * @throws Error if `BROKENSTOCK_DB` is unset.
 * @throws Error if `aws.rds.<BROKENSTOCK_DB>` is not present in config.
 */
export function loadPostgresConfig(
  ec: ExecutionContext,
  profile: AWSIniProfile,
): PostgresAppConfig {
  const log = new LoggerApi(ec, 'postgres-app', 'config-loader', 'loadPostgresConfig');

  const envName = process.env['BROKENSTOCK_DB'];
  if (!envName) {
    throw new Error(
      'BROKENSTOCK_DB environment variable is not set; postgres-app requires single-DB-per-process pinning',
    );
  }

  const rds = new Rds(ec, profile);
  const rdsConfig = rds.resolveConnectionConfig(envName);

  const pgCtx = ec.get<PostgresContext>(postgresContextKey) ?? {};
  const userPool = pgCtx.pool ?? {};
  const pool = {
    min: userPool.min ?? DEFAULT_POOL.min,
    max: userPool.max ?? DEFAULT_POOL.max,
    idleTimeoutMillis: userPool.idleTimeoutMillis ?? DEFAULT_POOL.idleTimeoutMillis,
    connectionTimeoutMillis: userPool.connectionTimeoutMillis ?? DEFAULT_POOL.connectionTimeoutMillis,
  };

  log.debug({envName, pool}, 'postgres-app config resolved');

  return {rds: rdsConfig, pool};
}
