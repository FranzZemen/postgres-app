/*
Created by Franz Zemen
License Type: UNLICENSED
*/

// Side-effect import: registers the postgres schema with ExecutionContext at
// module load. Must be imported before any `ec.put(postgresContextKey, ...)`.
import './validation.js';

export {
  postgresContextKey,
  type PostgresPoolSizing,
  type PostgresContext,
  type PostgresAppConfig,
} from './types.js';
export {loadPostgresConfig} from './load-postgres-config.js';
export {postgresContextSchema} from './validation.js';
