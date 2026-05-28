# `@franzzemen/postgres-app` — Usage

**Companion docs:** [intent](../intent/package.intent.md), [guide](../guide/package.guide.md).

Code-first reference for consumer integration.

## Minimal worker boot

```ts
import {ExecutionContext} from '@franzzemen/execution-context';
import {loadNodeExecutionContext} from '@franzzemen/execution-context-node-loader';
import {loadPostgresConfig} from '@franzzemen/postgres-app/config-loader';
import {createPool} from '@franzzemen/postgres-app/pool';
import {createKysely} from '@franzzemen/postgres-app/query';
import {verifyMinSchemaVersion} from '@franzzemen/postgres-app/migrations';

import {MIN_SCHEMA_VERSION} from './schema-version.js';
import type {Database} from './db/database.js';

async function boot(): Promise<void> {
  const ec = await loadNodeExecutionContext({
    secret: process.env.AWSSECRET!,
    jsonEncryptPath: './config.json.encrypt',
    jsonFilePath: './config.json',
    executionName: 'my-worker',
  });

  const cfg = loadPostgresConfig(ec, 'rds-user');
  const pool = createPool(ec, cfg);
  await verifyMinSchemaVersion(ec, pool, MIN_SCHEMA_VERSION);
  const db = createKysely<Database>(pool);

  process.on('SIGTERM', async () => {
    await pool.end();
    process.exit(0);
  });

  // ... worker loop using db ...
}

boot().catch((err) => {
  console.error('boot failed:', err);
  process.exit(1);
});
```

## Kysely query examples

### Simple SELECT

```ts
const trades = await db
  .selectFrom('trades')
  .select(['id', 'symbol', 'created_at'])
  .where('symbol', '=', 'AAPL')
  .orderBy('created_at', 'desc')
  .limit(10)
  .execute();
```

### INSERT with RETURNING

```ts
const inserted = await db
  .insertInto('trades')
  .values({symbol: 'AAPL'})
  .returning(['id', 'created_at'])
  .executeTakeFirstOrThrow();
```

### Transaction with nested savepoint

```ts
import type {Transaction} from '@franzzemen/postgres-app/tx';
import type {Database} from './db/database.js';

async function recordTradeAndYield(
  db: Kysely<Database>,
  symbol: string,
  yieldBps: number,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const trade = await trx
      .insertInto('trades')
      .values({symbol})
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx.transaction().execute(async (trx2: Transaction<Database>) => {
      await trx2
        .insertInto('trade_yield_segments')
        .values({trade_id: trade.id, yield_bps: yieldBps})
        .execute();
    });

    return trade.id;
  });
}
```

## LISTEN / NOTIFY: queue consumer pattern

```ts
import {createListenClient} from '@franzzemen/postgres-app/listen';

const listen = createListenClient(ec, cfg);

await listen.subscribe('trade_queue', async (payload) => {
  const {trade_id} = JSON.parse(payload);
  await processTrade(trade_id);
});

process.on('SIGTERM', async () => {
  await listen.close();
  await pool.end();
  process.exit(0);
});
```

Producer side (any process with pool access):

```ts
await pool.query("NOTIFY trade_queue, $1", [JSON.stringify({trade_id: 42})]);
```

For higher-throughput workloads, pair LISTEN with `FOR UPDATE SKIP LOCKED` polling so multiple workers can drain a queue table without coordination — the LISTEN signal triggers an immediate poll, and `SKIP LOCKED` distributes rows.

## Migrations

Migration file at `<consumer-package>/migrations/1700000005000_add_trade_yield_segments.cjs`:

```js
exports.up = (pgm) => {
  pgm.createTable('trade_yield_segments', {
    id: { type: 'serial', primaryKey: true },
    trade_id: { type: 'integer', notNull: true, references: 'trades(id)' },
    yield_bps: { type: 'integer', notNull: true },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('trade_yield_segments');
};
```

Run via `bs.server-migrate` (C10) — or directly in code if needed:

```ts
import {runMigrations} from '@franzzemen/postgres-app/migrations';

await runMigrations(ec, pool, {
  direction: 'up',
  migrationsDir: path.resolve(import.meta.dirname, '../migrations'),
  migrationsTable: 'pgmigrations_my_package',
});
```

## `MIN_SCHEMA_VERSION` declaration

```ts
// src/project/schema-version.ts
/**
 * Largest migration id this code depends on. Bumped manually when a new
 * migration is required by changes shipping in this PR.
 */
export const MIN_SCHEMA_VERSION = 1700000005000;
```

Boot check:

```ts
import {verifyMinSchemaVersion, MinSchemaVersionError} from '@franzzemen/postgres-app/migrations';
import {MIN_SCHEMA_VERSION} from './schema-version.js';

try {
  await verifyMinSchemaVersion(ec, pool, MIN_SCHEMA_VERSION, 'pgmigrations_my_package');
} catch (err) {
  if (err instanceof MinSchemaVersionError) {
    console.error(
      `Schema gate failed: required ${err.required}, applied ${err.applied} on ${err.database}. ` +
      `Run bs.server-migrate before deploying this code.`,
    );
    process.exit(1);
  }
  throw err;
}
```

## Dynamic where clauses

```ts
async function findTrades(filters: {symbol?: string; afterDate?: Date}) {
  let query = db.selectFrom('trades').selectAll();
  if (filters.symbol) query = query.where('symbol', '=', filters.symbol);
  if (filters.afterDate) query = query.where('created_at', '>=', filters.afterDate);
  return query.execute();
}
```

Kysely returns a new immutable builder on each `.where()` — chaining is safe across awaits.

## Raw SQL escape hatch

When kysely can't express something (advisory locks, `COPY`, `LISTEN`, complex CTEs), use `pool.query()` directly:

```ts
import {sql} from 'kysely';

// Via kysely's sql tag (preferred — keeps result typing):
const r = await sql<{count: number}>`SELECT COUNT(*)::int AS count FROM trades`.execute(db);

// Via raw pg (when you need pg-specific features):
await pool.query("SELECT pg_advisory_xact_lock(hashtext($1))", ['migration-lock']);
```

## What NOT to do

- **Don't construct `pg.Pool` directly.** Use `createPool` so the IAM-auth `password` callback, SSL CA, and pool defaults are wired correctly.
- **Don't share one process across multiple databases.** One systemd unit per (role, env). `BROKENSTOCK_DB` pins the process.
- **Don't use the `aws.rds` config block for pool sizing** — that block belongs to `aws-app/rds`. Pool knobs go under `postgres.pool`.
- **Don't import from `@franzzemen/postgres-app` directly** — use subpaths. There's no barrel export by design.
- **Don't keep listen connections open longer than the IAM token window without expecting reconnects.** The listen client handles reconnect gracefully; if you're tracking "is the listen connection alive" externally, you'll see flapping during token rotation — that's normal.
