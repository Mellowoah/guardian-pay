import pg from 'pg';

export interface StoredEvent { paypal_event_id: string; event_type: string; verified: boolean; received_at: string }
export interface EventStore {
  /** returns true if newly inserted, false if the event id was already stored */
  insert(e: { id: string; type: string; verified: boolean; payload: unknown }): Promise<boolean>;
  recent(limit: number): Promise<StoredEvent[]>;
  kind: 'memory' | 'postgres';
}

export class MemoryStore implements EventStore {
  kind = 'memory' as const;
  private rows: StoredEvent[] = [];
  async insert(e: { id: string; type: string; verified: boolean }) {
    if (this.rows.some(r => r.paypal_event_id === e.id)) return false;
    this.rows.push({ paypal_event_id: e.id, event_type: e.type, verified: e.verified, received_at: new Date().toISOString() });
    return true;
  }
  async recent(limit: number) { return this.rows.slice(-limit).reverse(); }
}

export class PgStore implements EventStore {
  kind = 'postgres' as const;
  private pool: pg.Pool;
  constructor(url: string) {
    // Render internal URLs need no TLS; external (*.render.com) URLs do.
    const ssl = /\.render\.com/.test(url) ? { rejectUnauthorized: false } : undefined;
    this.pool = new pg.Pool({ connectionString: url, ssl, max: 5 });
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGSERIAL PRIMARY KEY,
      paypal_event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      verified BOOLEAN NOT NULL,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  }
  async insert(e: { id: string; type: string; verified: boolean; payload: unknown }) {
    const r = await this.pool.query(
      `INSERT INTO webhook_events (paypal_event_id, event_type, verified, payload) VALUES ($1,$2,$3,$4)
       ON CONFLICT (paypal_event_id) DO NOTHING`, [e.id, e.type, e.verified, JSON.stringify(e.payload)]);
    return (r.rowCount ?? 0) === 1;
  }
  async recent(limit: number) {
    const r = await this.pool.query(
      `SELECT paypal_event_id, event_type, verified, received_at FROM webhook_events ORDER BY id DESC LIMIT $1`, [limit]);
    return r.rows.map(x => ({ ...x, received_at: new Date(x.received_at).toISOString() }));
  }
}
