/*
Created by Franz Zemen
License Type: UNLICENSED

Shared bootstrap for integration tests. Loads config.json from CWD (which
must live next to package.json on the test host) and seeds an
ExecutionContext with the `aws` and `postgres` blocks under their canonical
keys. Integration tests must be run from a host with VPC reach to the
Aurora cluster (the EC2 worker host); BROKENSTOCK_DB must be set in env.
*/

import {readFileSync, existsSync} from 'node:fs';
import {ExecutionContext} from '@franzzemen/execution-context';

const CONFIG_PATH = './config.json';

interface TestConfig {
  aws: Record<string, unknown>;
  postgres?: Record<string, unknown>;
}

let cached: TestConfig | null = null;

function loadConfig(): TestConfig {
  if (cached) return cached;
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Integration tests require ./config.json next to package.json. ` +
      `See doc/guide/package.guide.md for the expected shape.`,
    );
  }
  cached = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as TestConfig;
  return cached;
}

export function makeTestEc(): ExecutionContext {
  const cfg = loadConfig();
  const ec = new ExecutionContext();
  ec.put('aws', cfg.aws);
  if (cfg.postgres) {
    ec.put('postgres', cfg.postgres);
  }
  return ec;
}

export function getBrokenstockDb(): string {
  const v = process.env['BROKENSTOCK_DB'];
  if (!v) {
    throw new Error('BROKENSTOCK_DB env var must be set for integration tests');
  }
  return v;
}
