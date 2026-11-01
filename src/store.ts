import type { Db } from './db.js';

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
  constructor(private db: Db) {}
  async insert(e: { id: string; type: string; verified: boolean; payload: unknown }) {
    const r = await this.db.query(
      `INSERT INTO webhook_events (paypal_event_id, event_type, verified, payload) VALUES ($1,$2,$3,$4)
       ON CONFLICT (paypal_event_id) DO NOTHING`, [e.id, e.type, e.verified, JSON.stringify(e.payload)]);
    return (r.rowCount ?? 0) === 1;
  }
  async recent(limit: number) {
    const r = await this.db.query(
      `SELECT paypal_event_id, event_type, verified, received_at FROM webhook_events ORDER BY id DESC LIMIT $1`, [limit]);
    return r.rows.map((x: any) => ({ ...x, received_at: new Date(x.received_at).toISOString() }));
  }
}
