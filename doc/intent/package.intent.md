# `@franzzemen/postgres-app` — Intent

**Audience:** AI agents and future maintainers.
**Purpose:** Why this package exists, what it does and does not do, and how it fits into the brokenstock architecture migration (Era 0).

## Why this package exists

The brokenstock architecture is moving from DynamoDB + Lambda + SQS to Aurora Serverless v2 + EC2 worker fleet + PostgreSQL queue tables (Era 0 of `~/dev/projects/doc/intent/architecture-evolution.intent.md`). Every long-running worker process on the fleet needs to open authenticated, SSL-secured connections to Aurora. `postgres-app` is that connection layer.

It exists as its own package (rather than living inside `@franzzemen/aws-app`) because:

- **Aurora connection management is not an AWS SDK concern.** `aws-app` wraps AWS service clients. The pg driver, kysely query builder, LISTEN/NOTIFY plumbing, and migration tooling are PostgreSQL concerns. Folding them into `aws-app` would muddle the wrapper's purpose and force every `aws-app` consumer to install `pg`, `kysely`, and `node-pg-migrate`.
- **It does, however, consume `aws-app/rds`** (C4) for the AWS-specific bits — IAM token minting and the RDS global CA bundle — honoring the AWS-SDK-encapsulation rule: only `aws-app` directly imports `@aws-sdk/*`.

## Scope: what's in, what's out

**In scope (worker fleet only):**

- pg.Pool factory with IAM-auth token-on-connect callback
- Kysely query builder construction over the pool
- Native kysely transaction support (re-exported `Transaction<DB>` type)
- Dedicated long-lived LISTEN/NOTIFY client with auto-reconnect + subscription replay
- `node-pg-migrate` wrapper that injects an IAM-auth connection
- `MIN_SCHEMA_VERSION` enforcement helper for boot-time + deploy pre-flight checks
- Config-loader reading the `postgres.pool` block from execution-context

**Out of scope:**

- **Lambdas.** Per `~/dev/projects/doc/intent/architecture-evolution.intent.md`, Lambdas are not tied to a VPC. Lambdas that need to write to Aurora (e.g. enqueueing from S3 events to the PG queue table) use Aurora Data API via a separate `@franzzemen/aws-app/rds-data` subpath (not authored in this package). Native PG protocol requires VPC connectivity and is unsuitable for Lambda.
- **Per-tenant or per-shard pool routing.** One process is pinned to one database via the `BROKENSTOCK_DB` env var. The four environment databases (`dev_franz`, `integration`, `prod_blue`, `prod_green`) are deployment targets of the same code, not multi-tenant data partitions. If brokenstock ever grows sharded tenants, the pinning convention would extend to env-shard pairs (`prod_blue_shard1`) without changing this design.
- **Reader endpoint splitting.** Default is the cluster writer endpoint. The `config-loader` accepts an optional `readerHost` so the door is open; the actual read-replica routing helper lands in a future PRD when a real read-only workload exists.
- **Kysely codegen.** Each consumer hand-writes its own `Database` interface for the tables it owns. No schema-introspection codegen at this stage; if hand-written interfaces become painful, codegen can be added then.
- **CA bundle hot-reload.** AWS rotates the RDS global CA bundle on a long schedule. When it rotates, `aws-app` is republished with the new bundle and consumers bump. Out of scope here.

## Why kysely (not Drizzle, Prisma, or raw pg)

Decided in the C5 PRD interview (see `~/dev/projects/doc/prd/era-0-postgres-app-package.prd.md`, D3):

- **Drizzle/Prisma** own their own migration systems; using their query API while ignoring their migrator means fighting the framework. The C5 PRD locked `node-pg-migrate` from the parent Intent Doc, so these were out.
- **Raw `pg`** is fine for static SQL but devolves into hand-rolled dynamic-SQL string concatenation for non-trivial queries — historical injection-bug terrain.
- **Knex** has weaker TS than kysely and brings its own (ignored) migration system.
- **Kysely** is TS-first, immutable builder, ~no runtime overhead, paired cleanly with `node-pg-migrate`. Each consumer owns its `Database` interface.

## Why single-DB pinning per process

The four databases are environmental deployment targets, not multi-tenant data domains. Pinning matches that model:

- **Blast radius:** a worker process can only damage the one DB it's pinned to.
- **Connection budget:** Aurora has a hard ceiling on concurrent connections. Pooling per DB across processes scales gracefully; one process holding pools for all four DBs would multiply per-DB pool size by env count for idle workers.
- **Blue/green deploy mechanics:** "stop the green-pinned processes, start blue-pinned processes" is literally what blue/green means here. Pinning is the deploy primitive.
- **Aligns with C8's systemd template unit model** (`brokenstock-worker@<role>-<env>.service`). One unit per role+env, one process per unit, one DB per process.

## Subpath layout

Per [[feedback-aws-sdk-encapsulation]] / the wrapper-package convention in `~/.claude/CLAUDE.md`, consumers import from specific subpaths so Node's `import`-graph doesn't pull every dependency at module load:

| Subpath | Surface |
|---|---|
| `./config-loader` | `loadPostgresConfig(ec, profile)` + `PostgresAppConfig` types + schema registration |
| `./pool` | `createPool(ec, config) → pg.Pool` |
| `./query` | `createKysely<DB>(pool) → Kysely<DB>` |
| `./tx` | re-export of kysely's `Transaction<DB>` type |
| `./listen` | `createListenClient(ec, config) → ListenClient` (subscribe/unsubscribe/close) |
| `./migrations` | `runMigrations()`, `verifyMinSchemaVersion()`, `MinSchemaVersionError` |

No barrel export. Consumers import only the subpaths they use.

## Token freshness strategy

Aurora IAM auth tokens have a ~15-minute TTL. Two patterns coexist:

- **Pool connections:** `pg.Pool` invokes the `password` callback (function form) on every new physical connection. Each connection holds a fresh token at the moment it's established. `idleTimeoutMillis` defaults to 10 minutes — pool connections recycle inside the token window, so the token never expires mid-use. No proactive refresh.
- **Listen connection:** a single long-lived `pg.Client` holds its token for the lifetime of the connection. When the token expires (typically ~15 min after connect), Aurora drops the socket. The listen client's reconnect loop catches the drop, mints a new token, reconnects, and replays subscribed channels. The 1s→30s exponential backoff prevents thundering during sustained Aurora outages.

## `MIN_SCHEMA_VERSION` discipline

Per [[project-schema-migration-discipline]]:

- Each consumer package declares its own `MIN_SCHEMA_VERSION` constant (`export const MIN_SCHEMA_VERSION = 1700000005000;`) — the largest migration id the code requires to be applied.
- At worker boot, consumer calls `verifyMinSchemaVersion(pool, MIN_SCHEMA_VERSION)`. If the DB's `pgmigrations.max(id)` is below required, the call throws `MinSchemaVersionError` and the worker refuses to start.
- The same check runs as a `bs.server-deploy` pre-flight gate (C10): deploy refuses to proceed against a DB whose schema is behind the new code's requirement. Migrations must be applied (via `bs.server-migrate`) before the rolling restart begins.

This is the expand-contract migration pattern's enforcement mechanism — code only runs when the schema it needs is in place.

## Related

- Parent: `~/dev/projects/doc/intent/architecture-evolution.intent.md` (Front 4 — PG queue replaces SQS; Era 0)
- PRD: `~/dev/projects/doc/prd/era-0-postgres-app-package.prd.md`
- Dependency: `@franzzemen/aws-app/rds` (C4 — IAM token signer + CA bundle)
- Downstream: `bs.server-deploy` (C10 — uses `verifyMinSchemaVersion` as pre-flight)
- Memories: `project-schema-migration-discipline`, `project-era-0-database-decisions`, `project-lambda-discipline`, `feedback-aws-sdk-encapsulation`
