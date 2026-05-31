/*
Created by Franz Zemen
License Type: UNLICENSED

Programmatic `migrate` orchestrator — the high-level entry point that
`bin/pg-app-migrate.ts` and `@franzzemen/aws-build-system`'s `abs.migrate`
wrap. Loads postgres-app config (driven by `BROKENSTOCK_DB`), creates a pool,
runs migrations, and tears the pool down.

Use the lower-level `runMigrations` directly if you already own a pool.
*/

import type {AWSIniProfile} from '@franzzemen/aws-app/context';
import {ExecutionContext} from '@franzzemen/execution-context';
import {LoggerApi} from '@franzzemen/logger';
import {loadPostgresConfig} from '../config-loader/index.js';
import {createPool} from '../pool/index.js';
import {runMigrations} from './run-migrations.js';

export interface MigrateArgs {
  /** Absolute path to the migrations directory (e.g. from `migrationsDir` export of a DDL package). */
  migrationsDir: string;
  /** Defaults to 'up'. */
  direction?: 'up' | 'down';
  /** Number of migrations to apply. Omitted = all pending. */
  count?: number;
  /** Defaults to 'pgmigrations' (node-pg-migrate convention). */
  migrationsTable?: string;
  /** AWS profile for IAM RDS auth (defaults to 'rds-user'). */
  awsProfile?: AWSIniProfile;
}

/**
 * Run migrations against the database selected by `BROKENSTOCK_DB`.
 *
 * Caller must have:
 *   - loaded an ExecutionContext (via the secrets-loader bootstrap,
 *     e.g. `loadSecretsExecutionContext`),
 *   - set `BROKENSTOCK_DB` to the target env's role/database identifier,
 *   - resolved `migrationsDir` (typically from a DDL package's
 *     `migrationsDir` export, discovered via `require.resolve`).
 *
 * The pool is created, used, and ended within this call — single-shot.
 */
export async function migrate(ec: ExecutionContext, args: MigrateArgs): Promise<void> {
  const log = new LoggerApi(ec, 'postgres-app', 'migrations', 'migrate');
  const profile: AWSIniProfile = args.awsProfile ?? 'rds-user';
  const cfg = loadPostgresConfig(ec, profile);
  const pool = createPool(ec, cfg);
  try {
    log.info(
      {
        direction: args.direction ?? 'up',
        migrationsDir: args.migrationsDir,
        migrationsTable: args.migrationsTable ?? 'pgmigrations',
      },
      'starting migrations',
    );
    await runMigrations(ec, pool, {
      direction: args.direction ?? 'up',
      migrationsDir: args.migrationsDir,
      ...(args.count !== undefined ? {count: args.count} : {}),
      ...(args.migrationsTable !== undefined ? {migrationsTable: args.migrationsTable} : {}),
    });
    log.info('migrations complete');
  } finally {
    await pool.end();
  }
}
