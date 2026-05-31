/*
Created by Franz Zemen
License Type: UNLICENSED

Integration test for ./migrations: apply a temporary migration against
dev_franz, verify schema version reflects it, roll back, confirm cleanup.

Uses an isolated migrations table name (`pgmigrations_postgres_app_test`) so
this test never collides with a real consumer's `pgmigrations` table on the
same database.

Run from the EC2 worker host.
*/

import 'mocha';
import * as chai from 'chai';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {loadPostgresConfig} from '../project/config-loader/index.js';
import {createPool} from '../project/pool/index.js';
import {
  runMigrations,
  verifyMinSchemaVersion,
  MinSchemaVersionError,
} from '../project/migrations/index.js';
import {makeTestEc, getBrokenstockDb, warmAurora} from './test-context.js';

const expect = chai.expect;

const TEST_TABLE = 'pgmigrations_postgres_app_test';
const TEST_TARGET_TABLE = 'postgres_app_test_smoke';

describe('@franzzemen/postgres-app/migrations (integration)', function () {
  this.timeout(120_000);

  let pool: Pool;
  let ec: Awaited<ReturnType<typeof makeTestEc>>;
  let migrationsDir: string;

  before(async () => {
    process.env['BROKENSTOCK_DB'] = process.env['BROKENSTOCK_DB'] ?? 'dev_franz';
    getBrokenstockDb();
    ec = await makeTestEc();
    const cfg = loadPostgresConfig(ec, 'rds-user');
    pool = createPool(ec, cfg);
    await warmAurora(pool);

    migrationsDir = mkdtempSync(join(tmpdir(), 'pgapp-mig-'));
    // Pre-Era-1.6 filename convention: ISO 8601 UTC, lex-sortable.
    writeFileSync(
      join(migrationsDir, '2026-05-30T140000Z_create_smoke.cjs'),
      `
exports.up = (pgm) => {
  pgm.createTable('${TEST_TARGET_TABLE}', {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true },
  });
};
exports.down = (pgm) => {
  pgm.dropTable('${TEST_TARGET_TABLE}');
};
`,
      'utf-8',
    );
  });

  after(async () => {
    // Best-effort cleanup of any state the test left behind.
    if (pool) {
      try {
        await pool.query(`DROP TABLE IF EXISTS ${TEST_TARGET_TABLE}`);
        await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
      } catch {/* ignore */}
      await pool.end();
    }
    if (migrationsDir) {
      rmSync(migrationsDir, {recursive: true, force: true});
    }
  });

  it('verifyMinSchemaVersion fails when migrations have not yet been applied', async () => {
    // Pristine state: drop both possible tables first.
    await pool.query(`DROP TABLE IF EXISTS ${TEST_TARGET_TABLE}`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE}`);

    let caught: unknown = null;
    try {
      await verifyMinSchemaVersion(ec, pool, '2026-05-30T140000Z_create_smoke', TEST_TABLE);
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(MinSchemaVersionError);
    const e = caught as MinSchemaVersionError;
    expect(e.required).to.equal('2026-05-30T140000Z_create_smoke');
    expect(e.database).to.equal(getBrokenstockDb());
    expect(e.migrationsTable).to.equal(TEST_TABLE);
  });

  it('runMigrations applies the test migration and the target table exists', async () => {
    await runMigrations(ec, pool, {
      direction: 'up',
      migrationsDir,
      migrationsTable: TEST_TABLE,
    });
    const r = await pool.query<{exists: boolean}>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`,
      [TEST_TARGET_TABLE],
    );
    expect(r.rows[0]?.exists).to.equal(true);
  });

  it('verifyMinSchemaVersion passes after migration applied (exact match)', async () => {
    // The applied migration is '2026-05-30T140000Z_create_smoke'; requiring exactly
    // that timestamp must pass (string >= comparison).
    await verifyMinSchemaVersion(ec, pool, '2026-05-30T140000Z_create_smoke', TEST_TABLE);
  });

  it('verifyMinSchemaVersion passes when an OLDER timestamp is required', async () => {
    // A newer applied migration (2026-...) satisfies an older requirement (2025-...).
    await verifyMinSchemaVersion(ec, pool, '2025-01-01T000000Z_anything', TEST_TABLE);
  });

  it('verifyMinSchemaVersion fails when a NEWER timestamp is required', async () => {
    let caught: unknown = null;
    try {
      await verifyMinSchemaVersion(ec, pool, '2099-01-01T000000Z_future', TEST_TABLE);
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(MinSchemaVersionError);
    expect((caught as MinSchemaVersionError).required).to.equal('2099-01-01T000000Z_future');
  });

  it('runMigrations rolls back and the target table is gone', async () => {
    await runMigrations(ec, pool, {
      direction: 'down',
      count: 1,
      migrationsDir,
      migrationsTable: TEST_TABLE,
    });
    const r = await pool.query<{exists: boolean}>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`,
      [TEST_TARGET_TABLE],
    );
    expect(r.rows[0]?.exists).to.equal(false);
  });
});
