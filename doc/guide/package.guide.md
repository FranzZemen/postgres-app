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

- A `src/project/migrations/` directory holding its `node-pg-migrate` files (timestamped `.ts`, transpiled to `out/project/migrations/*.js`). See the [MIN_SCHEMA_VERSION intent doc](../intent/min-schema-version-semantics.intent.md) for the filename convention.
- A `MIN_SCHEMA_VERSION` constant — the timestamp-string filename (without extension) of the largest migration the code depends on. Bumped manually when a new migration is required by the code change shipping in the same PR.

```ts
// In consumer package, src/project/schema-version.ts
export const MIN_SCHEMA_VERSION = '2026-05-30T140030Z_worker_jobs';
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

- Migrations live at `<consumer-package>/src/project/migrations/` (timestamped `.ts` files transpiled to `out/project/migrations/*.js`; see the [intent doc](../intent/min-schema-version-semantics.intent.md)).
- `pg-app.migrate <env> --migrations-package=<pkg>` (the CLI shipped by this package) calls the programmatic `migrate(ec, ...)` orchestrator against the target env. Per-product wrappers (e.g. `abs.migrate` in `@franzzemen/aws-build-system`) hard-code the DDL package name.
- Worker boot and the per-product deploy pre-flight both call `verifyMinSchemaVersion()` with the consumer's `MIN_SCHEMA_VERSION`.

The migration runner uses the same IAM-auth pool as runtime — no separate password-based admin path.

### `migrationsTable`

Default is `pgmigrations` (node-pg-migrate's default), and that is the canonical name across the schema. The earlier `pgmigrations_<package-suffix>` convention is retired (Pre-Era-1.6): when consumers share a database, migration-tree isolation is enforced by database boundaries, not per-table name suffixes. The `--migrations-table` flag on `pg-app.migrate` remains available as an escape hatch for non-Brokenstock deployments.

### `pg-app.migrate` CLI

Shape:

```
pg-app.migrate <env> --migrations-package=<pkg-name> [--direction up|down] [--count N] [--migrations-table <name>]
```

The CLI resolves the named npm package's `migrationsDir` export (via `require.resolve('<pkg>/package.json')` + dynamic `import('<pkg>')`), sets `BROKENSTOCK_DB=<env>` so `postgres-app`'s config-loader picks the right `aws.rds.<role>` block, then runs `node-pg-migrate` against that directory.

**Bootstrap (production callers):** the CLI loads configuration via `@franzzemen/execution-context-secrets-loader`'s `loadSecretsExecutionConfigsFunction`, fetching the full execution-context config from AWS Secrets Manager (default `secretKey: 'execution-context'`). There is no `AWSSECRET` env var, no `./config.json.encrypt` lookup, and no cwd assumption. The host process (EC2 worker, CI runner, etc.) must have IAM permissions to read the secret — typically via the `Secrets-Manager-User-Policy` managed policy that the broken-stock-admin lambdas also use. See Pre-Era-1.7 D1/D7 in `~/dev/projects/doc/prd/pre-era-1.7-secrets-loader-and-migration-shape.prd.md` for the rationale (convergence on one config-delivery model across lambda + EC2; retirement of NAT-era `config.json.encrypt`-in-artifact).

**Bootstrap (test callers):** integration tests in this package and in consumer packages continue to use `loadNodeExecutionContext` with a local `config.json` / `config.json.encrypt` pair. Production and test bootstrap paths live side-by-side per the global D2 split — code picks at the entrypoint level, not at runtime. See [the testing section](#testing) below.

The CLI accepts any DDL package that exports `migrationsDir: string`; `postgres-app` itself stays product-agnostic.

## Testing

### Test layout

Two layers, separated by filename glob so the default `bs.test` invocation stays publish-friendly:

| File suffix | Glob | Invocation | Reach required |
|---|---|---|---|
| `*.test.ts` | `out/test/**/*.test.js` (the `bs.test` default) | `npx bs.test` | none — pure unit tests, mocked ec |
| `*.itest.ts` | `out/test/**/*.itest.js` | `npm run test:integration` | VPC reach to Aurora |

Integration tests are **not** disabled — they're just opt-in. `npmu`'s automatic `bs.test` runs unit only and can publish from any host; `npm run test:integration` runs the real-Aurora tests explicitly when you ask.

### Config

The encrypted `config.json.encrypt` is committed to the repo. Decryption requires `AWSSECRET` in env. A plain `config.json` next to `package.json` is supported as a local-dev override (gitignored). `test-context.ts` uses `loadNodeExecutionContext` to handle both — same pattern as `aws-app` tests.

### Running integration tests from the EC2 worker host

Simplest path. The host has VPC reach, instance-role IAM credentials, and `AWSSECRET` available:

```bash
# SSM into the host as the brokenstock user
aws ssm start-session --target i-0302bb5c17ad3aa1d --region us-west-2 --profile brokenstock-admin
sudo su - brokenstock
cd ~/dev/postgres-app
git pull && npm install
AWSSECRET=$AWSSECRET BROKENSTOCK_DB=dev_franz npm run test:integration
```

Expect 9 tests; first cold start ~30s due to Aurora scale-from-zero.

### Running integration tests from the laptop via SSM tunnel

Useful for tighter iteration without committing every change. Three things have to be true: TCP reaches Aurora (via tunnel), DNS resolves the cluster hostname to that tunnel, and SSL + IAM auth still see the real hostname (so neither rejects the connection).

**Step 1 — Open the SSM port-forward tunnel** (runs in its own terminal, stays open until Ctrl-C):

```bash
aws ssm start-session \
  --target i-0302bb5c17ad3aa1d \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["brokenstock-nonprod-aurora.cluster-ct25p21tys1f.us-west-2.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}' \
  --region us-west-2 \
  --profile brokenstock-admin
```

Local port 5432 → SSM session → EC2 worker host → onward TCP to Aurora cluster:5432.

**Step 2 — Map the cluster hostname to 127.0.0.1** (so SSL cert + IAM auth signature both match the hostname `pg.Pool` actually dials):

```bash
echo "127.0.0.1 brokenstock-nonprod-aurora.cluster-ct25p21tys1f.us-west-2.rds.amazonaws.com" \
  | sudo tee -a /etc/hosts
```

Without this, `pg.connect()` to the cluster endpoint would still resolve to AWS's real IPs (which the laptop can't reach), and connecting directly to `localhost` would mismatch the SSL cert (`*.cluster-ct25p21tys1f.us-west-2.rds.amazonaws.com`) and the IAM auth token (signed for the cluster hostname).

**Step 3 — Run the tests** (in a different terminal):

```bash
cd ~/dev/postgres-app
AWSSECRET=$AWSSECRET BROKENSTOCK_DB=dev_franz npm run test:integration
```

**Step 4 — Cleanup when done:**

```bash
# Ctrl-C the tunnel terminal, then:
sudo sed -i '/brokenstock-nonprod-aurora.cluster-ct25p21tys1f.us-west-2.rds.amazonaws.com/d' /etc/hosts
```

### Gotchas

- **Local port 5432 must be free.** If a local Postgres is running on 5432, stop it or pick another `localPortNumber` for the tunnel — but then you'd also have to override the port in `config.json` for the tunneled test run. Stopping local PG is simpler.
- **Session Manager plugin required.** Install once: see `https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-debian-and-ubuntu.html`.
- **IAM:** the principal running `aws ssm start-session` needs `ssm:StartSession` on the `AWS-StartPortForwardingSessionToRemoteHost` document. The `brokenstock-admin` profile has it via the admin policy.
- **Aurora scale-from-zero** still applies — `warmAurora()` in the test bootstrap retries `SELECT 1` until the cluster stabilizes. First run after the cluster has been idle takes ~30s.

## Operational notes

- **Process-per-DB.** Don't try to share one process across multiple databases. Run a separate systemd unit per (role, env) pair.
- **No singleton state inside `postgres-app`.** The pool, kysely client, and listen client are constructed by the consumer (typically once at boot) and held in consumer-owned references. The package exports factories, not module-scope singletons.
- **Graceful shutdown** must call `pool.end()` and `listenClient.close()`. Without them, SIGTERM-on-deploy leaves Aurora connections in TIME_WAIT until the OS reaps them.
- **Token expiry mid-query is not handled.** Pool's `idleTimeoutMillis: 600_000` keeps individual connections inside the 15-min token window. If you raise idle timeout above 15 minutes, expect auth errors and connection drops.
