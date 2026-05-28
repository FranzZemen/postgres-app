/*
Created by Franz Zemen
License Type: UNLICENSED
*/

import {ExecutionContext} from '@franzzemen/execution-context';
import {postgresContextKey} from './types.js';

/**
 * fastest-validator schema for the `postgres` block in ExecutionContext.
 *
 * Registered at module load time so consumers can `ec.put(postgresContextKey, ...)`
 * without first calling `registerSchema`. Mirrors the aws-app pattern.
 */
export const postgresContextSchema = {
  $$strict: false as const,
  pool: {
    type: 'object',
    optional: true,
    strict: false,
    props: {
      min: {type: 'number', integer: true, min: 0, optional: true},
      max: {type: 'number', integer: true, min: 1, optional: true},
      idleTimeoutMillis: {type: 'number', integer: true, min: 0, optional: true},
      connectionTimeoutMillis: {type: 'number', integer: true, min: 0, optional: true},
    },
  },
};

ExecutionContext.registerSchema(
  postgresContextKey,
  postgresContextSchema,
  undefined,
  {sourcePackage: '@franzzemen/postgres-app'},
);
