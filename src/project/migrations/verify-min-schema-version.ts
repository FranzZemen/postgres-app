/*
Created by Franz Zemen
License Type: UNLICENSED
*/

import type {Pool} from 'pg';
import {ExecutionContext} from '@franzzemen/execution-context';
import {LoggerApi} from '@franzzemen/logger';

/**
 * Thrown by `verifyMinSchemaVersion` when the database's applied schema is
 * older than the consumer's required minimum. Callers (workers at boot,
 * `bs.server-deploy` pre-flight) should treat this as fatal — do NOT start
 * the worker / proceed with the deploy until migrations have been applied.
 */
export class MinSchemaVersionError extends Error {
  readonly required: number;
  readonly applied: number;
  readonly database: string;

  constructor(required: number, applied: number, database: string) {
    super(
      `database '${database}' is at schema version ${applied}, ` +
      `but consumer requires >= ${required}; run migrations before starting`,
    );
    this.name = 'MinSchemaVersionError';
    this.required = required;
    this.applied = applied;
    this.database = database;
  }
}

/**
 * Verify that the database's applied schema version is >= `required`.
 *
 * "Version" = the largest `id` in the `pgmigrations` table (node-pg-migrate's
 * monotonically-increasing migration number). If the table is missing or
 * empty, applied version is 0 — which fails any positive requirement, as
 * intended (the consumer's migrations haven't been applied yet).
 *
 * Per the per-consumer MIN_SCHEMA_VERSION discipline: each consumer package
 * declares its own constant and calls this function at boot. The boot then
 * fails fast if the deploy ordering was wrong (code rolled out before
 * migrations).
 *
 * @throws MinSchemaVersionError if applied < required.
 */
export async function verifyMinSchemaVersion(
  ec: ExecutionContext,
  pool: Pool,
  required: number,
  migrationsTable: string = 'pgmigrations',
): Promise<void> {
  const log = new LoggerApi(ec, 'postgres-app', 'migrations', 'verifyMinSchemaVersion');

  const client = await pool.connect();
  try {
    const tableExistsResult = await client.query<{exists: boolean}>(
      'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists',
      [migrationsTable],
    );
    const tableExists = tableExistsResult.rows[0]?.exists === true;

    let applied = 0;
    if (tableExists) {
      const maxResult = await client.query<{max_id: number | null}>(
        `SELECT MAX(id)::int AS max_id FROM ${quoteIdentifier(migrationsTable)}`,
      );
      applied = maxResult.rows[0]?.max_id ?? 0;
    }

    const database = (await client.query<{current_database: string}>(
      'SELECT current_database()',
    )).rows[0]?.current_database ?? 'unknown';

    if (applied < required) {
      throw new MinSchemaVersionError(required, applied, database);
    }

    log.debug({required, applied, database}, 'min schema version check passed');
  } finally {
    client.release();
  }
}

/**
 * Quote a PostgreSQL identifier safely. The migrations table name is
 * caller-supplied (configurable), so we cannot rely on parameterized queries
 * here (PG won't bind identifiers, only values).
 */
function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid migrations table name: ${name}`);
  }
  return `"${name}"`;
}
