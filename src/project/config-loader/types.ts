/*
Created by Franz Zemen
License Type: UNLICENSED
*/

import type {RdsConnectionConfig} from '@franzzemen/aws-app/rds';

/**
 * Key used to look up the postgres-app block in ExecutionContext.
 */
export const postgresContextKey = 'postgres';

/**
 * Pool sizing knobs. All optional in config; resolved to defaults in
 * `loadPostgresConfig` if not supplied.
 */
export interface PostgresPoolSizing {
  min?: number;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

/**
 * Shape of the `postgres` block in config.json.
 *
 * Example (kebab-case in file, camelCase in code per the config convention):
 * ```json
 * {
 *   "postgres": {
 *     "pool": {
 *       "max": 10,
 *       "idle-timeout-millis": 600000,
 *       "connection-timeout-millis": 5000
 *     }
 *   }
 * }
 * ```
 *
 * Connection settings (endpoint, port, database, IAM user, region) are NOT
 * here — they live under `aws.rds.<envName>` and are resolved through
 * `@franzzemen/aws-app/rds`'s `Rds.resolveConnectionConfig(envName)`. The
 * `envName` selector comes from the `BROKENSTOCK_DB` env var.
 */
export interface PostgresContext {
  pool?: PostgresPoolSizing;
}

/**
 * Resolved postgres-app configuration: connection details from aws-app/rds
 * plus fully-resolved pool sizing.
 */
export interface PostgresAppConfig {
  /** From `Rds.resolveConnectionConfig(BROKENSTOCK_DB)`. */
  rds: RdsConnectionConfig;
  /** Pool sizing with defaults applied. */
  pool: Required<PostgresPoolSizing>;
}
