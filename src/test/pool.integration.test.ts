/*
Created by Franz Zemen
License Type: UNLICENSED

Integration test for ./pool against the real dev_franz Aurora database.
Run from the EC2 worker host (VPC reach required).
*/

import 'mocha';
import * as chai from 'chai';
import type {Pool} from 'pg';
import {loadPostgresConfig} from '../project/config-loader/index.js';
import {createPool} from '../project/pool/index.js';
import {createKysely} from '../project/query/index.js';
import {makeTestEc, getBrokenstockDb, warmAurora} from './test-context.js';

const expect = chai.expect;

interface MinimalDb {
  pg_catalog_dummy: never;
}

describe('@franzzemen/postgres-app/pool (integration)', function () {
  // Aurora cold-start can take 15-30s if cluster scaled to zero.
  this.timeout(120_000);

  let pool: Pool;

  before(async () => {
    process.env['BROKENSTOCK_DB'] = process.env['BROKENSTOCK_DB'] ?? 'dev_franz';
    getBrokenstockDb();
    const ec = makeTestEc();
    const cfg = loadPostgresConfig(ec, 'rds-user');
    pool = createPool(ec, cfg);
    await warmAurora(pool);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  it('connects and runs SELECT 1', async () => {
    const r = await pool.query<{one: number}>('SELECT 1::int AS one');
    expect(r.rows[0]?.one).to.equal(1);
  });

  it('reports the expected current_database and current_user', async () => {
    const r = await pool.query<{db: string; usr: string}>(
      'SELECT current_database() AS db, current_user AS usr',
    );
    expect(r.rows[0]?.db).to.equal(getBrokenstockDb());
    expect(r.rows[0]?.usr).to.equal('brokenstock_app');
  });

  it('handles transaction commit via kysely', async () => {
    const db = createKysely<MinimalDb>(pool);
    const result = await db.transaction().execute(async (trx) => {
      const r = await trx
        .selectNoFrom((eb) => [eb.lit(42).as('x')])
        .executeTakeFirstOrThrow();
      return r.x;
    });
    expect(result).to.equal(42);
  });
});
