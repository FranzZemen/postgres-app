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
// Side-effect: register the postgres schema before any ec.put('postgres', ...).
import '../project/config-loader/validation.js';

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

/**
 * Aurora Serverless v2 scaled-to-zero clusters drop the first few native-PG
 * connect attempts during the scale-from-zero wake-up (Data API would handle
 * this gracefully; native PG socket resets are surfaced as "Connection
 * terminated unexpectedly"). Retry SELECT 1 a few times with delays so
 * integration tests can run from cold against dev_franz without manual
 * pre-warming.
 *
 * No-op once Aurora is hot.
 */
import type {Pool} from 'pg';
export async function warmAurora(pool: Pool): Promise<void> {
  const maxAttempts = 8;
  const delayMs = 5_000;
  let lastErr: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      if (i < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw new Error(
    `Aurora warm-up failed after ${maxAttempts} attempts: ${(lastErr as Error)?.message ?? lastErr}`,
  );
}
