/*
Created by Franz Zemen
License Type: UNLICENSED
*/

import 'mocha';
import * as chai from 'chai';
import {ExecutionContext} from '@franzzemen/execution-context';
import {loadPostgresConfig, postgresContextKey} from '../project/config-loader/index.js';

const expect = chai.expect;

describe('@franzzemen/postgres-app/config-loader', () => {
  const origEnv = process.env['BROKENSTOCK_DB'];
  const origPoolMax = process.env['BROKENSTOCK_DB_POOL_MAX'];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['BROKENSTOCK_DB'];
    } else {
      process.env['BROKENSTOCK_DB'] = origEnv;
    }
    if (origPoolMax === undefined) {
      delete process.env['BROKENSTOCK_DB_POOL_MAX'];
    } else {
      process.env['BROKENSTOCK_DB_POOL_MAX'] = origPoolMax;
    }
  });

  const ecWithRds = (): ExecutionContext => {
    const ec = new ExecutionContext();
    ec.put('aws', {
      region: 'us-west-2',
      environment: 'lambda',
      rds: {
        dev_franz: {
          clusterEndpoint: 'example.us-west-2.rds.amazonaws.com',
          port: 5432,
          database: 'dev_franz',
          iamUser: 'brokenstock_app',
        },
      },
    });
    return ec;
  };

  it('throws when BROKENSTOCK_DB env var is missing', () => {
    delete process.env['BROKENSTOCK_DB'];
    const ec = new ExecutionContext();
    ec.put('aws', {region: 'us-west-2', environment: 'lambda'});
    expect(() => loadPostgresConfig(ec, 'rds-user'))
      .to.throw(/BROKENSTOCK_DB/);
  });

  it('throws when aws.rds.<envName> is missing', () => {
    process.env['BROKENSTOCK_DB'] = 'dev_franz';
    const ec = new ExecutionContext();
    ec.put('aws', {region: 'us-west-2', environment: 'lambda'});
    expect(() => loadPostgresConfig(ec, 'rds-user'))
      .to.throw(/aws\.rds/i);
  });

  it('returns a resolved config with default pool sizing when postgres block absent', () => {
    process.env['BROKENSTOCK_DB'] = 'dev_franz';
    const ec = new ExecutionContext();
    ec.put('aws', {
      region: 'us-west-2',
      environment: 'lambda',
      rds: {
        dev_franz: {
          clusterEndpoint: 'example.us-west-2.rds.amazonaws.com',
          port: 5432,
          database: 'dev_franz',
          iamUser: 'brokenstock_app',
        },
      },
    });
    const cfg = loadPostgresConfig(ec, 'rds-user');
    expect(cfg.rds.endpoint).to.equal('example.us-west-2.rds.amazonaws.com');
    expect(cfg.rds.database).to.equal('dev_franz');
    expect(cfg.rds.user).to.equal('brokenstock_app');
    expect(cfg.pool.min).to.equal(0);
    expect(cfg.pool.max).to.equal(10);
    expect(cfg.pool.idleTimeoutMillis).to.equal(600_000);
    expect(cfg.pool.connectionTimeoutMillis).to.equal(5_000);
  });

  it('applies user-supplied pool overrides on top of defaults', () => {
    process.env['BROKENSTOCK_DB'] = 'dev_franz';
    const ec = new ExecutionContext();
    ec.put('aws', {
      region: 'us-west-2',
      environment: 'lambda',
      rds: {
        dev_franz: {
          clusterEndpoint: 'example.us-west-2.rds.amazonaws.com',
          port: 5432,
          database: 'dev_franz',
          iamUser: 'brokenstock_app',
        },
      },
    });
    ec.put(postgresContextKey, {
      pool: {max: 3, idleTimeoutMillis: 60_000},
    });
    const cfg = loadPostgresConfig(ec, 'rds-user');
    expect(cfg.pool.max).to.equal(3);
    expect(cfg.pool.idleTimeoutMillis).to.equal(60_000);
    expect(cfg.pool.min).to.equal(0);
    expect(cfg.pool.connectionTimeoutMillis).to.equal(5_000);
  });

  it('BROKENSTOCK_DB_POOL_MAX overrides the default (PRD E3 per-worker sizing)', () => {
    process.env['BROKENSTOCK_DB'] = 'dev_franz';
    process.env['BROKENSTOCK_DB_POOL_MAX'] = '16';
    const cfg = loadPostgresConfig(ecWithRds(), 'rds-user');
    expect(cfg.pool.max).to.equal(16);
  });

  it('BROKENSTOCK_DB_POOL_MAX takes precedence over the config block pool.max', () => {
    process.env['BROKENSTOCK_DB'] = 'dev_franz';
    process.env['BROKENSTOCK_DB_POOL_MAX'] = '7';
    const ec = ecWithRds();
    ec.put(postgresContextKey, {pool: {max: 3}});
    const cfg = loadPostgresConfig(ec, 'rds-user');
    expect(cfg.pool.max).to.equal(7);
  });

  it('ignores an invalid BROKENSTOCK_DB_POOL_MAX and falls back', () => {
    process.env['BROKENSTOCK_DB'] = 'dev_franz';
    process.env['BROKENSTOCK_DB_POOL_MAX'] = 'not-a-number';
    const ec = ecWithRds();
    ec.put(postgresContextKey, {pool: {max: 5}});
    const cfg = loadPostgresConfig(ec, 'rds-user');
    expect(cfg.pool.max).to.equal(5); // falls back to config block
  });

  it('ignores a zero/negative BROKENSTOCK_DB_POOL_MAX and falls back to default', () => {
    process.env['BROKENSTOCK_DB'] = 'dev_franz';
    process.env['BROKENSTOCK_DB_POOL_MAX'] = '0';
    const cfg = loadPostgresConfig(ecWithRds(), 'rds-user');
    expect(cfg.pool.max).to.equal(10); // default
  });
});
