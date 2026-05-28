/*
Created by Franz Zemen
License Type: UNLICENSED

Integration test for ./listen: subscribe + NOTIFY roundtrip.
Run from the EC2 worker host.
*/

import 'mocha';
import * as chai from 'chai';
import type {Pool} from 'pg';
import {loadPostgresConfig} from '../project/config-loader/index.js';
import {createPool} from '../project/pool/index.js';
import {createListenClient, type ListenClient} from '../project/listen/index.js';
import {makeTestEc, getBrokenstockDb, warmAurora} from './test-context.js';

const expect = chai.expect;

describe('@franzzemen/postgres-app/listen (integration)', function () {
  this.timeout(120_000);

  let pool: Pool;
  let listenClient: ListenClient;

  before(async () => {
    process.env['BROKENSTOCK_DB'] = process.env['BROKENSTOCK_DB'] ?? 'dev_franz';
    getBrokenstockDb();
    const ec = await makeTestEc();
    const cfg = loadPostgresConfig(ec, 'rds-user');
    pool = createPool(ec, cfg);
    await warmAurora(pool);
    listenClient = createListenClient(ec, cfg);
    // Give the dedicated listen client a moment to complete its initial
    // connect handshake after Aurora is warm. Subsequent reconnects (if any)
    // are handled by the listen client's own backoff loop.
    await new Promise((r) => setTimeout(r, 2_000));
  });

  after(async () => {
    if (listenClient) await listenClient.close();
    if (pool) await pool.end();
  });

  it('receives a NOTIFY payload after subscribing', async () => {
    const channel = `pgapp_test_${Date.now()}`;
    const expected = `hello-${Math.random().toString(36).slice(2)}`;

    const received: string[] = [];
    let resolveGot!: () => void;
    const got = new Promise<void>((resolve) => {
      resolveGot = resolve;
    });
    const handler = (payload: string): void => {
      received.push(payload);
      resolveGot();
    };

    await listenClient.subscribe(channel, handler);

    // Give the LISTEN command a beat to register before NOTIFY (re-connect race).
    await new Promise((r) => setTimeout(r, 500));

    await pool.query(`NOTIFY ${channel}, '${expected}'`);

    await Promise.race([
      got,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for NOTIFY')), 10_000),
      ),
    ]);

    expect(received).to.deep.equal([expected]);

    await listenClient.unsubscribe(channel, handler);
  });

  it('rejects channel names with embedded double-quotes', async () => {
    let threw = false;
    try {
      await listenClient.subscribe('bad"name', () => {/* */});
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.match(/invalid channel name/);
    }
    expect(threw).to.equal(true);
  });
});
