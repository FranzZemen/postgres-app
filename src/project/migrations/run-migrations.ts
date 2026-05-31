/*
Created by Franz Zemen
License Type: UNLICENSED
*/

import {runner} from 'node-pg-migrate';
import type {Pool} from 'pg';
import {ExecutionContext} from '@franzzemen/execution-context';
import {LoggerApi} from '@franzzemen/logger';

export interface RunMigrationsArgs {
  direction: 'up' | 'down';
  /** Number of migrations to apply; defaults to all pending. */
  count?: number;
  /** Absolute path to the consumer's migrations directory. */
  migrationsDir: string;
  /**
   * Migrations table name; defaults to `pgmigrations` (node-pg-migrate's
   * convention). Per-consumer override allowed but discouraged — the
   * MIN_SCHEMA_VERSION check assumes this matches.
   */
  migrationsTable?: string;
}

/**
 * Run pending migrations using node-pg-migrate against the IAM-auth pool.
 *
 * The migration runner checks out a single connection from the pool for the
 * duration; the IAM token is supplied by the pool's `password` callback so
 * migrations use the same auth path as runtime.
 */
export async function runMigrations(
  ec: ExecutionContext,
  pool: Pool,
  args: RunMigrationsArgs,
): Promise<void> {
  const log = new LoggerApi(ec, 'postgres-app', 'migrations', 'runMigrations');
  const client = await pool.connect();
  try {
    log.debug(
      {direction: args.direction, count: args.count, dir: args.migrationsDir},
      'running migrations',
    );
    const runnerOpts: Parameters<typeof runner>[0] = {
      dbClient: client,
      dir: args.migrationsDir,
      direction: args.direction,
      migrationsTable: args.migrationsTable ?? 'pgmigrations',
      verbose: false,
      // Skip dotfiles AND source maps. node-pg-migrate's default ignorePattern
      // is dotfiles only; without this, every `.js.map` shipped alongside a
      // transpiled migration is treated as a migration and the runner throws
      // ERR_UNKNOWN_FILE_EXTENSION trying to load it.
      ignorePattern: '(?:\\..*|.*\\.map)',
    };
    if (args.count !== undefined) {
      runnerOpts.count = args.count;
    }
    await runner(runnerOpts);
  } finally {
    client.release();
  }
}
