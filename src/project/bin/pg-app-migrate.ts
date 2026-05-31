#!/usr/bin/env node
/*
Created by Franz Zemen
License Type: UNLICENSED

pg-app.migrate — generic Postgres migrations CLI.

Usage:
  pg-app.migrate <env> (--migrations-package=<pkg-name> | --migrations-dir=<abs-path>) [--direction up|down] [--count N] [--migrations-table <name>]

Positional:
  <env>                          The BROKENSTOCK_DB role identifier (e.g. dev_franz, prod_blue).

Migration source (exactly one required):
  --migrations-package, -p       The npm package name whose `migrationsDir` export
                                 holds the migration files (e.g. @franzzemen/brokenstock-postgres-ddl).
  --migrations-dir <abs-path>    Absolute filesystem path to a directory of migration
                                 files. Bypasses module resolution entirely.

Optional flags:
  --direction up|down            Default: up.
  --count N                      Number of migrations to apply. Default: all pending.
  --migrations-table <name>      Default: pgmigrations.
  -h, --help                     Show this help.

The CLI:
  1. Sets BROKENSTOCK_DB=<env> so postgres-app's config-loader picks the right DB.
  2. Bootstraps the execution context from AWS Secrets Manager via
     @franzzemen/execution-context-secrets-loader (host IAM supplies read access).
  3. Resolves the migrations directory either by dynamic import of
     --migrations-package, or directly from --migrations-dir if passed.
  4. Calls the programmatic `migrate(ec, ...)` orchestrator from
     @franzzemen/postgres-app/migrations.
*/

import {parseArgs} from 'node:util';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {ExecutionContext} from '@franzzemen/execution-context';
import {LoggerApi} from '@franzzemen/logger';
import {LoadSecretsExecutionConfigsFunctionInputs, loadSecretsExecutionContext} from '@franzzemen/execution-context-secrets-loader';
import {migrate} from '../migrations/migrate.js';

const HELP = `Usage: pg-app.migrate <env> (--migrations-package=<pkg-name> | --migrations-dir=<abs-path>) [--direction up|down] [--count N] [--migrations-table <name>]

Run migrations from a DDL package (or directory) against the env's Postgres database.

Positional:
  <env>                          BROKENSTOCK_DB role (e.g. dev_franz, prod_blue).

Migration source (exactly one required):
  --migrations-package, -p       npm package exporting a 'migrationsDir' string.
  --migrations-dir <abs-path>    Absolute path to a directory of migration files.

Optional:
  --direction up|down            Default: up.
  --count N                      Number of migrations to apply.
  --migrations-table <name>      Default: pgmigrations.
  -h, --help                     Show this help.
`;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('-h') || rawArgs.includes('--help')) {
    console.log(HELP);
    process.exit(0);
  }

  const {values, positionals} = parseArgs({
    args: rawArgs,
    options: {
      'migrations-package': {type: 'string', short: 'p'},
      'migrations-dir': {type: 'string'},
      'direction': {type: 'string'},
      'count': {type: 'string'},
      'migrations-table': {type: 'string'},
    },
    allowPositionals: true,
    strict: true,
  });

  const env = positionals[0];
  const pkgName = values['migrations-package'];
  const migrationsDirArg = values['migrations-dir'];
  if (!env) {
    console.error(HELP);
    process.exit(1);
  }
  if (!pkgName && !migrationsDirArg) {
    console.error('one of --migrations-package or --migrations-dir is required');
    console.error(HELP);
    process.exit(1);
  }
  if (pkgName && migrationsDirArg) {
    console.error('--migrations-package and --migrations-dir are mutually exclusive');
    process.exit(1);
  }

  const directionRaw = values['direction'] ?? 'up';
  if (directionRaw !== 'up' && directionRaw !== 'down') {
    console.error(`--direction must be 'up' or 'down', got '${directionRaw}'`);
    process.exit(1);
  }
  const direction: 'up' | 'down' = directionRaw;

  const countRaw = values['count'];
  let count: number | undefined;
  if (countRaw !== undefined) {
    count = parseInt(countRaw, 10);
    if (!Number.isFinite(count) || count < 0) {
      console.error(`--count must be a non-negative integer, got '${countRaw}'`);
      process.exit(1);
    }
  }

  const migrationsTable = values['migrations-table'];

  // Resolve the migrations directory. Two paths:
  //   --migrations-dir <abs-path> — used directly after absolute-path + existence check.
  //   --migrations-package <name> — dynamic import walks node_modules per Node's
  //     standard resolution and will throw ERR_MODULE_NOT_FOUND with a clear
  //     message if the package isn't installed. We deliberately do NOT pre-check
  //     via `require.resolve(<pkg>/package.json)` because modern packages with
  //     restrictive `exports` fields reject the ./package.json subpath access
  //     (ERR_PACKAGE_PATH_NOT_EXPORTED) — forcing every consumer of
  //     pg-app.migrate to explicitly export their package.json just to pass a
  //     sanity check.
  let migrationsDir: string;
  if (migrationsDirArg) {
    if (!path.isAbsolute(migrationsDirArg)) {
      console.error(`--migrations-dir must be an absolute path, got '${migrationsDirArg}'`);
      process.exit(1);
    }
    if (!existsSync(migrationsDirArg)) {
      console.error(`--migrations-dir does not exist: '${migrationsDirArg}'`);
      process.exit(1);
    }
    migrationsDir = migrationsDirArg;
  } else {
    // pkgName is non-empty here (mutual-exclusion + required-one checks above).
    const pkgModule = (await import(pkgName!)) as {migrationsDir?: string};
    const resolved = pkgModule.migrationsDir;
    if (typeof resolved !== 'string' || resolved.length === 0) {
      console.error(
        `package '${pkgName}' does not export a 'migrationsDir' string; ` +
        `cannot locate migrations directory`,
      );
      process.exit(1);
    }
    migrationsDir = resolved;
  }

  // Pin the database for postgres-app's config-loader BEFORE bootstrap.
  process.env['BROKENSTOCK_DB'] = env;

  // Bootstrap follows the lambda-batch pattern (Pre-Era-1.7 PRD D7).
  const inputs: LoadSecretsExecutionConfigsFunctionInputs = {
    bootstrap: {
      awsContext: {
        secretsManager: {
          currentSecretSetName: 'production',
          secretSetNames: ['production'],
        },
        environment: 'lambda',
      },
      // Profile string is a label only — actual permission scoping comes from
      // the host EC2 IAM role's Secrets-Manager-User-Policy attachment
      // (Pre-Era-1.7 D8). The whole ecosystem (lambdas + workers + this CLI)
      // uses 'secrets-manager-admin' as the label for consistency.
      profile: 'secrets-manager-admin',
    },
    overrides: {
      'aws': {environment: 'lambda', lambda: {timeoutSeconds: 10}},
      'execution-context': {name: 'pg-app-migrate'},
      'log-config': {modules: {modulesToLoad: ['cloudWatchLoggerFactory']}},
    },
  };
  await loadSecretsExecutionContext(inputs);
  const ec = new ExecutionContext();
  await LoggerApi.load(ec);
  const log = new LoggerApi(ec, 'postgres-app', 'pg-app-migrate', 'main');

  log.info({env, pkgName, migrationsDirArg, migrationsDir, direction, count, migrationsTable}, 'pg-app.migrate starting');

  await migrate(ec, {
    migrationsDir,
    direction,
    ...(count !== undefined ? {count} : {}),
    ...(migrationsTable !== undefined ? {migrationsTable} : {}),
  });

  console.log(`pg-app.migrate: ${direction} complete against env='${env}'`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
