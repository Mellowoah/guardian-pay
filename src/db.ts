import pg from 'pg';

export type Q = { query: pg.Pool['query'] };
export interface Db {
  pool: pg.Pool;
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
  /** runs fn in a transaction. If lockKey is given, takes a transaction-scoped advisory lock first (serialises per milestone). */
  tx<T>(fn: (c: pg.PoolClient) => Promise<T>, lockKey?: string): Promise<T>;
  close(): Promise<void>;
}

export function connect(url: string): Db {
  // Render internal URLs need no TLS; external (*.render.com) URLs do.
  const ssl = /\.render\.com/.test(url) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString: url, ssl, max: 10 });
  return {
    pool,
    query: (text, params) => pool.query(text, params as any[]),
    async tx(fn, lockKey) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        if (lockKey) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
        const r = await fn(c);
        await c.query('COMMIT');
        return r;
      } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
      finally { c.release(); }
    },
    close: () => pool.end(),
  };
}
