import pg, { Client, Pool } from "pg";
import type { PoolClient, QueryConfig } from "pg";

// workerd ties a socket to the request that opened it: a later request that
// reuses it hangs. Payload keeps one pg.Pool for the life of the isolate, so
// this Pool opens a fresh connection for every checkout and closes it on
// release. Hyperdrive pools the real database connections, so this stays cheap.
class RequestScopedPool extends Pool {
  override async connect(): Promise<PoolClient> {
    const client = new Client(this.options);

    await client.connect();

    return Object.assign(client, {
      release: () => {
        client.end().catch(() => {
          // The socket is already gone; nothing left to close.
        });
      },
    });
  }

  // @ts-expect-error drizzle only uses the promise form of pg.Pool's overloads.
  override async query(config: QueryConfig | string, values?: unknown[]) {
    const client = await this.connect();

    try {
      return await client.query(config, values);
    } finally {
      client.release();
    }
  }

  // Nothing to drain: every connection closes on release.
  // oxlint-disable-next-line class-methods-use-this -- overrides pg.Pool#end.
  override end() {
    return Promise.resolve();
  }
}

// SAFETY: only Pool differs from pg, and it keeps pg.Pool's public API.
export const requestScopedPg = { ...pg, Pool: RequestScopedPool } as typeof pg;
