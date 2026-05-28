/*
Created by Franz Zemen
License Type: UNLICENSED
*/

/**
 * Re-export kysely's Transaction type so consumers can type their
 * transactional functions without importing kysely directly.
 *
 * Canonical usage:
 * ```ts
 * await db.transaction().execute(async (trx) => {
 *   await trx.insertInto('foo').values(...).execute();
 *   await trx.updateTable('bar').set(...).execute();
 *   // Nested savepoint:
 *   await trx.transaction().execute(async (trx2) => { ... });
 * });
 * ```
 *
 * Kysely handles BEGIN/COMMIT/ROLLBACK and nested savepoints natively;
 * postgres-app does not wrap that.
 */
export type {Transaction} from 'kysely';
