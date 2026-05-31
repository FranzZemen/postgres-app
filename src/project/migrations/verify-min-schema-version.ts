/*
Created by Franz Zemen
License Type: UNLICENSED
*/

import type {Pool} from 'pg';
import {ExecutionContext} from '@franzzemen/execution-context';
import {LoggerApi} from '@franzzemen/logger';

/**
 * Thrown by `verifyMinSchemaVersion` when the database has NOT applied a
 * migration whose filename is >= the consumer's required minimum. Callers
 * (workers at boot, `bs.server-deploy` pre-flight) should treat this as
 * fatal — do NOT start the worker / proceed with the deploy until migrations
 * have been applied.
 */
export class MinSchemaVersionError extends Error {
  readonly required: string;
  readonly database: string;
  readonly migrationsTable: string;

  constructor(required: string, database: string, migrationsTable: string) {
    super(
      `database '${database}' has not applied a migration named >= '${required}' ` +
      `in table '${migrationsTable}'; run migrations before starting`,
    );
    this.name = 'MinSchemaVersionError';
    this.required = required;
    this.database = database;
    this.migrationsTable = migrationsTable;
  }
}

/**
 * Verify that the database has applied a migration with a name greater than
 * or equal to `minSchemaVersion`.
 *
 * **MIN_SCHEMA_VERSION is a TIMESTAMP STRING**, not a count or numeric id.
 * It is the filename (without extension) of the LARGEST migration the
 * consumer's code depends on — e.g. `'2026-05-30T140030Z_worker_jobs'`.
 * node-pg-migrate stores each applied migration in the `pgmigrations` table
 * (default name) with the filename in the `name` column; since filenames
 * follow the lex-sortable `YYYY-MM-DDTHHMMSSZ_<slug>` convention, plain
 * string `>=` comparison is the correct ordering check.
 *
 * If the migrations table is missing OR no row satisfies the predicate,
 * throw `MinSchemaVersionError`.
 *
 * Per the per-consumer MIN_SCHEMA_VERSION discipline: each consumer package
 * declares its own constant and calls this function at boot. The boot then
 * fails fast if the deploy ordering was wrong (code rolled out before
 * migrations).
 *
 * @throws MinSchemaVersionError if no migration with `name >= minSchemaVersion` exists.
 */
export async function verifyMinSchemaVersion(
  ec: ExecutionContext,
  pool: Pool,
  minSchemaVersion: string,
  migrationsTable: string = 'pgmigrations',
): Promise<void> {
  const log = new LoggerApi(ec, 'postgres-app', 'migrations', 'verifyMinSchemaVersion');

  const client = await pool.connect();
  try {
    const database = (await client.query<{current_database: string}>(
      'SELECT current_database()',
    )).rows[0]?.current_database ?? 'unknown';

    const tableExistsResult = await client.query<{exists: boolean}>(
      'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists',
      [migrationsTable],
    );
    const tableExists = tableExistsResult.rows[0]?.exists === true;

    if (!tableExists) {
      throw new MinSchemaVersionError(minSchemaVersion, database, migrationsTable);
    }

    const quotedTable = quoteIdentifier(migrationsTable);
    const result = await client.query(
      `SELECT 1 FROM ${quotedTable} WHERE name >= $1 LIMIT 1`,
      [minSchemaVersion],
    );

    if ((result.rowCount ?? 0) === 0) {
      throw new MinSchemaVersionError(minSchemaVersion, database, migrationsTable);
    }

    log.debug({required: minSchemaVersion, database}, 'min schema version check passed');
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
