/*
Created by Franz Zemen
License Type: UNLICENSED

Shared bootstrap for integration tests. Builds an ExecutionContext from the
committed `config.json.encrypt` blob (decrypted via the AWSSECRET env var).
A plain `config.json` next to `package.json` is supported as an optional
local-dev override and is gitignored.

Integration tests must be run from a host with VPC reach to the Aurora
cluster (typically the EC2 worker host); BROKENSTOCK_DB must be set in env.
Default `npx bs.test` does NOT run these — they live in `*.itest.ts` files
picked up by `npm run test:integration` only.
*/

import {loadNodeExecutionContext, type LoadExecutionConfigsFunctionInputs} from '@franzzemen/execution-context-node-loader';
import {ExecutionContext} from '@franzzemen/execution-context';
// Side-effect: register the postgres schema before any ec.put('postgres', ...).
import '../project/config-loader/validation.js';

let cached: ExecutionContext | null = null;

export async function makeTestEc(): Promise<ExecutionContext> {
  if (cached) return cached;

  const secret = process.env['AWSSECRET'];
  if (!secret) {
    throw new Error(
      'AWSSECRET env var must be set for integration tests (decrypts ./config.json.encrypt)',
    );
  }

  const inputs: LoadExecutionConfigsFunctionInputs = {
    secret,
    jsonEncryptPath: './config.json.encrypt',
    jsonFilePath: './config.json',
    executionName: 'postgres-app.integration-tests',
  };
  // Side effect: loads + registers configs (and decrypts secrets) into the
  // ExecutionContext singleton state. The fresh ec below picks them up.
  await loadNodeExecutionContext(inputs);
  cached = new ExecutionContext();
  return cached;
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
