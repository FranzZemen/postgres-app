/*
Created by Franz Zemen
License Type: UNLICENSED
*/

import {Kysely, PostgresDialect} from 'kysely';
import type {Pool} from 'pg';

/**
 * Wrap a pg.Pool in a kysely client.
 *
 * Consumers supply their own `Database` interface — one interface per
 * consumer package, owning that package's tables. No codegen.
 *
 * Caller owns the returned client. Kysely's `db.destroy()` calls
 * `pool.end()` under the hood, so a consumer that constructs the pool
 * separately should `pool.end()` directly at shutdown — don't call both.
 *
 * @example
 * ```ts
 * interface Database {
 *   trades: { id: string; symbol: string; created_at: Date; };
 * }
 * const db = createKysely<Database>(pool);
 * const rows = await db.selectFrom('trades').selectAll().execute();
 * ```
 */
export function createKysely<DB>(pool: Pool): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({pool}),
  });
}
