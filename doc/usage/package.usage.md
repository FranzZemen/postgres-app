# `@franzzemen/postgres-app` — Usage

**Companion docs:** [intent](../intent/package.intent.md), [guide](../guide/package.guide.md).

Code-first reference for consumer integration.

## Minimal worker boot (production: secrets-loader)

Production callers bootstrap from AWS Secrets Manager via
`@franzzemen/execution-context-secrets-loader`. No `AWSSECRET` env var, no
local `config.json.encrypt`. The host's IAM role supplies the read permission
(`Secrets-Manager-User-Policy` or equivalent). See Pre-Era-1.7 D1/D7 in
`~/dev/projects/doc/prd/pre-era-1.7-secrets-loader-and-migration-shape.prd.md`.

```ts
import {ExecutionContext} from '@franzzemen/execution-context';
import {loadSecretsExecutionConfigsFunction} from '@franzzemen/execution-context-secrets-loader';
import {loadPostgresConfig} from '@franzzemen/postgres-app/config-loader';
import {createPool} from '@franzzemen/postgres-app/pool';
import {createKysely} from '@franzzemen/postgres-app/query';
import {verifyMinSchemaVersion} from '@franzzemen/postgres-app/migrations';

import {MIN_SCHEMA_VERSION} from './schema-version.js';
import type {Database} from './db/database.js';

async function boot(): Promise<void> {
  await ExecutionContext.loadFromLoader(loadSecretsExecutionConfigsFunction, {
    bootstrap: {
      awsContext: {/* region + secretsManager.{currentSecretSetName, secretSetNames} */},
      profile: 'secrets-manager-user',
      secretKey: 'execution-context',
    },
  });
  const ec = new ExecutionContext();

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

## Test bootstrap (file-loader)

Integration tests stay on `loadNodeExecutionContext` with a local
`config.json.encrypt` (committed) and `config.json` override (gitignored). Run
with `AWSSECRET` in env. This is the only path that still reads local config
files; production code paths must not.

```ts
import {loadNodeExecutionContext} from '@franzzemen/execution-context-node-loader';
import {ExecutionContext} from '@franzzemen/execution-context';

await loadNodeExecutionContext({
  secret: process.env.AWSSECRET!,
  jsonEncryptPath: './config.json.encrypt',
  jsonFilePath: './config.json',
  executionName: 'postgres-app-test',
  environment: 'lambda',
});
const ec = new ExecutionContext();
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

Migration file at `<consumer-package>/src/project/migrations/2026-05-30T140030Z_add_trade_yield_segments.ts`
(transpiled to `out/project/migrations/2026-05-30T140030Z_add_trade_yield_segments.js`):

```ts
import type {MigrationBuilder} from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('trade_yield_segments', {
    id: {type: 'serial', primaryKey: true},
    trade_id: {type: 'integer', notNull: true, references: 'trades(id)'},
    yield_bps: {type: 'integer', notNull: true},
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('trade_yield_segments');
};
```

### Production: run via `pg-app.migrate`

The CLI bootstraps from Secrets Manager — no `AWSSECRET`, no local
`config.json.encrypt`. Caller's IAM role must permit reading the secret.

```bash
pg-app.migrate dev_franz --migrations-package=@franzzemen/brokenstock-postgres-ddl
pg-app.migrate dev_franz --migrations-package=@franzzemen/brokenstock-postgres-ddl --direction=down --count=1
```

`@franzzemen/aws-build-system` wraps this as `abs.migrate <env>` and hard-codes
`--migrations-package=@franzzemen/brokenstock-postgres-ddl` for Brokenstock.

### Programmatic (e.g. inside another tool)

```ts
import {migrate} from '@franzzemen/postgres-app/migrations';
import {migrationsDir} from '@franzzemen/brokenstock-postgres-ddl';

await migrate(ec, {
  migrationsDir,
  direction: 'up',
});
```

Default `migrationsTable: 'pgmigrations'` is canonical Brokenstock-wide. The
prior `pgmigrations_<package-suffix>` per-consumer convention is retired
(Pre-Era-1.6); override only for non-Brokenstock deployments.

## `MIN_SCHEMA_VERSION` declaration

```ts
// src/project/schema-version.ts
/**
 * Timestamp-string filename (without extension) of the largest migration this
 * code depends on. Bumped manually when a new migration is required by
 * changes shipping in this PR.
 */
export const MIN_SCHEMA_VERSION = '2026-05-30T140030Z_add_trade_yield_segments';
```

Boot check:

```ts
import {verifyMinSchemaVersion, MinSchemaVersionError} from '@franzzemen/postgres-app/migrations';
import {MIN_SCHEMA_VERSION} from './schema-version.js';

try {
  await verifyMinSchemaVersion(ec, pool, MIN_SCHEMA_VERSION, 'pgmigrations');
} catch (err) {
  if (err instanceof MinSchemaVersionError) {
    console.error(
      `Schema gate failed: required ${err.required} on ${err.database} (${err.migrationsTable}). ` +
      `Run pg-app.migrate (or the product-specific wrapper) before deploying this code.`,
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
