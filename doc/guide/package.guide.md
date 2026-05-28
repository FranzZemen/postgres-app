# `@franzzemen/postgres-app` — Guide

**Audience:** Engineers integrating `postgres-app` into a worker package.
**Companion docs:** [intent](../intent/package.intent.md), [usage](../usage/package.usage.md).

## Prerequisites

- Worker runs on the EC2 worker fleet (VPC reach to Aurora). Lambda integrations use Aurora Data API via `@franzzemen/aws-app/rds-data`, not this package.
- Aurora Serverless v2 cluster from Era 0 C3 deployed.
- `aws.rds.<envName>` sub-block in execution-context config for each database the worker will be pinned to.
- The worker process has the `BROKENSTOCK_DB` env var set to one of the four environment database names (`dev_franz`, `integration`, `prod_blue`, `prod_green`).
- IAM role on the worker host has `rds-db:connect` on the right Aurora `dbuser` resource ARN (C8 worker host role already includes this).

## Configuration

Two distinct config blocks:

### 1. `aws.rds.<envName>` (owned by `aws-app/rds`, C4)

Endpoint/port/database/IAM user/region. One sub-object per environment database. Consumed via `Rds.resolveConnectionConfig(envName)`.

```json
{
  "aws": {
    "region": "us-west-2",
    "environment": "lambda",
    "rds": {
      "dev_franz": {
        "clusterEndpoint": "brokenstock-nonprod-aurora.cluster-XXXXX.us-west-2.rds.amazonaws.com",
        "port": 5432,
        "database": "dev_franz",
        "iamUser": "brokenstock_app"
      }
    }
  }
}
```

> **`environment: "lambda"` on EC2?** Yes — `aws-app`'s `AWSUsageEnvironment` type is `'external' | 'lambda'`. `'external'` uses `fromIni({profile})` credentials; `'lambda'` falls through to the default credential chain, which on EC2 picks up the instance role. The naming gap (no `'ec2'` value) is a small `aws-app` cleanup item, not a behavioral issue.

### 2. `postgres.pool` (owned by `postgres-app`)

Pool sizing knobs. All optional; defaults applied per missing key. Kebab-case in the file (per [[feedback-config-json-keys]]), camelCase in code.

```json
{
  "postgres": {
    "pool": {
      "min": 0,
      "max": 10,
      "idle-timeout-millis": 600000,
      "connection-timeout-millis": 5000
    }
  }
}
```

Defaults:

| Key | Default | Rationale |
|---|---|---|
| `min` | `0` | Plays well with Aurora scale-to-zero — idle workers don't pin the cluster awake |
| `max` | `10` | Conservative ceiling per process; bump for high-throughput workers |
| `idleTimeoutMillis` | `600_000` (10 min) | Comfortably inside the 15-min IAM auth token TTL; connections recycle before tokens expire |
| `connectionTimeoutMillis` | `5_000` | Fast-fail in production. Bump to ~30s for dev testing against scale-to-zero clusters |

## Boot-time setup pattern

Canonical sequence for a worker process:

1. Load execution-context (config.json + secrets).
2. Call `loadPostgresConfig(ec, profile)` — reads `BROKENSTOCK_DB`, resolves the `aws.rds.<env>` sub-block, layers in `postgres.pool`.
3. Call `createPool(ec, config)` — returns a `pg.Pool` wired for IAM auth and SSL.
4. Call `verifyMinSchemaVersion(ec, pool, MIN_SCHEMA_VERSION)` — refuses to proceed if migrations haven't been applied.
5. Construct kysely client: `createKysely<MyDatabase>(pool)`.
6. (Optional) Construct listen client: `createListenClient(ec, config)`.
7. Register graceful shutdown handlers that call `pool.end()` and `listenClient.close()`.

See the [usage doc](../usage/package.usage.md) for concrete code.

## `MIN_SCHEMA_VERSION` per consumer

Each consumer package owns:

- A `migrations/` directory at package root holding its `node-pg-migrate` files (timestamped `.cjs` or `.sql`).
- A `MIN_SCHEMA_VERSION` constant — the largest migration id the code depends on. Bumped manually when a new migration is required by the code change shipping in the same PR.

```ts
// In consumer package, src/project/schema-version.ts
export const MIN_SCHEMA_VERSION = 1700000005000;
```

Boot enforcement:

```ts
import {MIN_SCHEMA_VERSION} from './schema-version.js';
await verifyMinSchemaVersion(ec, pool, MIN_SCHEMA_VERSION);
// If this throws MinSchemaVersionError, exit non-zero — do not proceed.
```

Deploy enforcement: `bs.server-deploy` (C10) runs the same check before triggering the rolling restart. Code does not reach a worker until the migration is applied.

## Kysely `Database` interface convention

Each consumer hand-writes a `Database` interface for its tables. One interface per package:

```ts
// src/project/db/database.ts
import type {Generated} from 'kysely';

export interface Database {
  trades: {
    id: Generated<number>;
    symbol: string;
    created_at: Generated<Date>;
  };
  trade_yield_segments: {
    id: Generated<number>;
    trade_id: number;
    yield_bps: number;
  };
}
```

Pass it to `createKysely`:
```ts
import {createKysely} from '@franzzemen/postgres-app/query';
import type {Database} from './db/database.js';

const db = createKysely<Database>(pool);
```

If hand-maintaining the interface becomes painful as the schema grows, codegen can be added in a future PRD. Not on the table for v1.

## Transactions

Use kysely's native transactions — `postgres-app/tx` only re-exports the `Transaction<DB>` type for consumer signatures. No wrapper helper:

```ts
await db.transaction().execute(async (trx) => {
  const trade = await trx.insertInto('trades').values({symbol: 'AAPL'}).returning('id').executeTakeFirstOrThrow();
  await trx.insertInto('trade_yield_segments').values({trade_id: trade.id, yield_bps: 42}).execute();

  // Nested savepoint:
  await trx.transaction().execute(async (trx2) => {
    await trx2.updateTable('trades').set({symbol: 'AAPL-adjusted'}).where('id', '=', trade.id).execute();
  });
});
```

## LISTEN / NOTIFY

`createListenClient` returns an opinionated client backed by a dedicated `pg.Client` (NOT a pool connection — pool connections recycle on the idle timeout, breaking long-lived LISTEN). Behavior:

- **Subscribe** validates the channel name immediately (rejects embedded `"`), then registers a handler. If the underlying connection is up, issues `LISTEN <channel>`. If the connection is still establishing, the channel is queued and `LISTEN` runs on connect.
- **Reconnect** triggers automatically on disconnect or token expiry. Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap). On reconnect, every subscribed channel's `LISTEN` is replayed before notifications resume.
- **Unsubscribe** is per-handler. The last unsubscribed handler triggers `UNLISTEN <channel>`.
- **Channels** are namespaced by consumer convention — `postgres-app` doesn't enforce anything beyond rejecting `"` in names.

## Migrations

`runMigrations()` and `verifyMinSchemaVersion()` wrap `node-pg-migrate`. Standard flow:

- Migrations live at `<consumer-package>/migrations/` (timestamped `.cjs` or `.sql` files following node-pg-migrate convention).
- `bs.server-migrate <env>` (C10) calls `runMigrations({direction: 'up', migrationsDir, migrationsTable})` against the target env.
- Worker boot and `bs.server-deploy` pre-flight both call `verifyMinSchemaVersion()` with the consumer's `MIN_SCHEMA_VERSION`.

The migration runner uses the same IAM-auth pool as runtime — no separate password-based admin path.

### `migrationsTable` per consumer

Multiple consumers can share a single database (e.g. dev_franz). To keep their migration trees isolated, each consumer passes its own `migrationsTable` name to `runMigrations` and `verifyMinSchemaVersion`. Convention: `pgmigrations_<package-suffix>` (e.g. `pgmigrations_trades`, `pgmigrations_yield`).

Default is `pgmigrations` (node-pg-migrate's default). Override per package.

## Testing against `dev_franz`

Integration tests must run from a host with VPC reach (the EC2 worker host). For repeated test cycles:

1. `git clone` on the host; `npm install`.
2. Drop a `config.json` next to `package.json` with `aws.rds.dev_franz` populated. Use `environment: "lambda"` so AWS SDK falls back to the instance role.
3. Set `BROKENSTOCK_DB=dev_franz` in env.
4. Bump `connection-timeout-millis` to `30000` in `postgres.pool` — Aurora scale-from-zero exceeds the production 5s default.
5. Tests include a `warmAurora()` helper that retries `SELECT 1` until Aurora's scale-from-zero stabilizes (Aurora drops the first few native-PG sockets during wake-up; Data API would handle gracefully). Each integration-test `before` calls it before any real test queries.
6. Run `BROKENSTOCK_DB=dev_franz npx bs.test`.

## Operational notes

- **Process-per-DB.** Don't try to share one process across multiple databases. Run a separate systemd unit per (role, env) pair.
- **No singleton state inside `postgres-app`.** The pool, kysely client, and listen client are constructed by the consumer (typically once at boot) and held in consumer-owned references. The package exports factories, not module-scope singletons.
- **Graceful shutdown** must call `pool.end()` and `listenClient.close()`. Without them, SIGTERM-on-deploy leaves Aurora connections in TIME_WAIT until the OS reaps them.
- **Token expiry mid-query is not handled.** Pool's `idleTimeoutMillis: 600_000` keeps individual connections inside the 15-min token window. If you raise idle timeout above 15 minutes, expect auth errors and connection drops.
