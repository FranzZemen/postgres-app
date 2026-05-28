/*
Created by Franz Zemen
License Type: UNLICENSED
*/

import {Client} from 'pg';
import {ExecutionContext} from '@franzzemen/execution-context';
import {LoggerApi} from '@franzzemen/logger';
import type {PostgresAppConfig} from '../config-loader/types.js';

export type NotifyHandler = (payload: string) => void | Promise<void>;

export interface ListenClient {
  /** Subscribe to a channel. Multiple handlers per channel are supported. */
  subscribe(channel: string, handler: NotifyHandler): Promise<void>;
  /** Remove a handler. If it was the last for the channel, issues UNLISTEN. */
  unsubscribe(channel: string, handler: NotifyHandler): Promise<void>;
  /** Tear down. Stops reconnect loop and ends the underlying pg client. */
  close(): Promise<void>;
}

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * Create a long-lived LISTEN/NOTIFY client backed by a dedicated `pg.Client`
 * (NOT a pool connection — pool connections recycle on `idleTimeoutMillis`).
 *
 * Behavior:
 * - On disconnect or auth error, reconnects with exponential backoff
 *   (1s → 30s cap). On reconnect, re-issues `LISTEN <channel>` for every
 *   channel with at least one active subscription.
 * - IAM token freshness: connection holds a token for as long as it lives,
 *   so a long-lived listen connection can outlive the 15-min token TTL.
 *   We don't proactively refresh; instead, when the token expires the
 *   server drops the connection and the reconnect loop mints a new token.
 *
 * Caller owns the returned client and must call `close()` at shutdown.
 */
export function createListenClient(
  ec: ExecutionContext,
  config: PostgresAppConfig,
): ListenClient {
  const log = new LoggerApi(ec, 'postgres-app', 'listen', 'createListenClient');

  const handlers = new Map<string, Set<NotifyHandler>>();
  let client: Client | null = null;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let connectingPromise: Promise<void> | null = null;

  const connect = async (): Promise<void> => {
    if (closed) return;
    if (connectingPromise) return connectingPromise;

    connectingPromise = (async () => {
      const token = await config.rds.tokenFn();
      const c = new Client({
        host: config.rds.endpoint,
        port: config.rds.port,
        database: config.rds.database,
        user: config.rds.user,
        password: token,
        ssl: {ca: config.rds.caBundle, rejectUnauthorized: true},
      });

      c.on('notification', (msg) => {
        const set = handlers.get(msg.channel);
        if (!set) return;
        for (const h of set) {
          Promise.resolve(h(msg.payload ?? '')).catch((err: unknown) => {
            log.error({err, channel: msg.channel}, 'listen handler threw');
          });
        }
      });

      c.on('error', (err) => {
        log.warn({err}, 'listen client error; will reconnect');
        // pg will emit 'end' after; reconnect happens there.
      });

      c.on('end', () => {
        if (closed) return;
        client = null;
        scheduleReconnect();
      });

      await c.connect();
      client = c;
      reconnectAttempt = 0;

      // Replay subscriptions on (re)connect.
      for (const channel of handlers.keys()) {
        await c.query(`LISTEN "${escapeChannel(channel)}"`);
      }

      log.debug(
        {channels: [...handlers.keys()], host: config.rds.endpoint},
        'listen client connected',
      );
    })();

    try {
      await connectingPromise;
    } finally {
      connectingPromise = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return;
    const delay = RECONNECT_BACKOFF_MS[
      Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
    ];
    reconnectAttempt++;
    log.warn({delayMs: delay, attempt: reconnectAttempt}, 'scheduling listen reconnect');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((err: unknown) => {
        log.error({err}, 'listen reconnect failed; will retry');
        scheduleReconnect();
      });
    }, delay);
  };

  // Kick off initial connect.
  connect().catch((err: unknown) => {
    log.error({err}, 'initial listen connect failed; will retry');
    scheduleReconnect();
  });

  return {
    async subscribe(channel: string, handler: NotifyHandler): Promise<void> {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
        if (client) {
          await client.query(`LISTEN "${escapeChannel(channel)}"`);
        }
      }
      set.add(handler);
    },

    async unsubscribe(channel: string, handler: NotifyHandler): Promise<void> {
      const set = handlers.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        handlers.delete(channel);
        if (client) {
          await client.query(`UNLISTEN "${escapeChannel(channel)}"`);
        }
      }
    },

    async close(): Promise<void> {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      handlers.clear();
      if (client) {
        try {
          await client.end();
        } catch (err) {
          log.warn({err}, 'error ending listen client (ignored)');
        }
        client = null;
      }
    },
  };
}

/**
 * Channel name needs to be quoted (LISTEN takes an identifier). Reject any
 * embedded double-quote to prevent identifier injection — channel names are
 * caller-supplied and we cannot use parameterized queries with LISTEN.
 */
function escapeChannel(channel: string): string {
  if (channel.includes('"')) {
    throw new Error(`invalid channel name (embedded double-quote): ${channel}`);
  }
  return channel;
}
