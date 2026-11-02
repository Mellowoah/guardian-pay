import type { Db } from './db.js';

export const MIGRATIONS: { id: string; sql: string }[] = [
  { id: '001_webhook_events', sql: `
    CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGSERIAL PRIMARY KEY,
      paypal_event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      verified BOOLEAN NOT NULL,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
    ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS reconcile_note TEXT;` },
  { id: '002_core', sql: `
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('family','provider','reviewer'))
    );
    CREATE TABLE providers (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL UNIQUE REFERENCES users(id),
      business_name TEXT NOT NULL
    );
    CREATE TABLE cases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      description TEXT,
      provider_id INT NOT NULL REFERENCES providers(id),
      family_user_id INT REFERENCES users(id),
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE milestones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      case_id UUID NOT NULL REFERENCES cases(id),
      seq INT NOT NULL,
      title TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      state TEXT NOT NULL DEFAULT 'created' CHECK (state IN ('created','authorized','reauthorized','proof_submitted','verified','captured','rejected','voided','expired')),
      proof_note TEXT,
      proof_submitted_at TIMESTAMPTZ,
      verified_note TEXT,
      rejection_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (case_id, seq)
    );
    CREATE TABLE payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      milestone_id UUID NOT NULL UNIQUE REFERENCES milestones(id),
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      paypal_order_id TEXT,
      approve_url TEXT,
      original_authorization_id TEXT,
      current_authorization_id TEXT,
      authorized_at TIMESTAMPTZ,
      reauthorized_at TIMESTAMPTZ,
      honor_until TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      capture_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending_order',
      attempts JSONB NOT NULL DEFAULT '{}'::jsonb,
      reauth_count INT NOT NULL DEFAULT 0,
      warned_at TIMESTAMPTZ,
      last_error TEXT,
      mismatch_flag BOOLEAN NOT NULL DEFAULT false,
      mismatch_note TEXT,
      webhook_confirmed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX payments_orig_auth ON payments (original_authorization_id);
    CREATE INDEX payments_cur_auth ON payments (current_authorization_id);
    CREATE INDEX payments_capture ON payments (capture_id);
    CREATE INDEX payments_order ON payments (paypal_order_id);
    CREATE TABLE approvals (
      id BIGSERIAL PRIMARY KEY,
      milestone_id UUID NOT NULL REFERENCES milestones(id),
      user_id INT NOT NULL REFERENCES users(id),
      decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX approvals_milestone ON approvals (milestone_id);
    CREATE TABLE audit_log (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      case_id UUID,
      before JSONB,
      after JSONB
    );
    CREATE INDEX audit_case ON audit_log (case_id, id);
    CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
    CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
    -- schema only for now: spending mandates (Layer 2)
    CREATE TABLE mandates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      case_id UUID REFERENCES cases(id),
      granted_by INT REFERENCES users(id),
      agent_label TEXT,
      scope JSONB NOT NULL DEFAULT '{}'::jsonb,
      max_amount NUMERIC(12,2),
      valid_until TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );` },
  { id: '003_seed_demo_users', sql: `
    INSERT INTO users (username, name, role) VALUES
      ('family_demo','Demo Family (synthetic)','family'),
      ('provider_demo','Demo Provider (synthetic)','provider'),
      ('provider_two','Second Demo Provider (synthetic)','provider'),
      ('reviewer_demo','Demo Reviewer (synthetic)','reviewer')
    ON CONFLICT (username) DO NOTHING;
    INSERT INTO providers (user_id, business_name)
      SELECT id, CASE username WHEN 'provider_demo' THEN 'Sunrise Home Care (synthetic)' ELSE 'Maple Legal Support (synthetic)' END
      FROM users WHERE role='provider' ON CONFLICT (user_id) DO NOTHING;` },
  { id: '004_proofs_verification', sql: `
    ALTER TABLE cases ADD COLUMN beneficiary_name TEXT;
    ALTER TABLE cases ADD COLUMN case_type TEXT;
    ALTER TABLE milestones ADD COLUMN expected_form_type TEXT;
    ALTER TABLE milestones ADD COLUMN expected_document_type TEXT CHECK (expected_document_type IN ('receipt_notice','rfe_response','interview_notice'));
    CREATE TABLE proofs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      milestone_id UUID NOT NULL REFERENCES milestones(id),
      uploaded_by INT NOT NULL REFERENCES users(id),
      filename TEXT,
      content_type TEXT NOT NULL,
      size_bytes INT NOT NULL,
      sha256 TEXT NOT NULL,
      has_image BOOLEAN NOT NULL DEFAULT false,
      bytes BYTEA,
      bytes_deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX proofs_milestone ON proofs (milestone_id);
    CREATE TABLE verification_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      proof_id UUID NOT NULL REFERENCES proofs(id),
      milestone_id UUID NOT NULL REFERENCES milestones(id),
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed')),
      provider TEXT,
      attempts INT NOT NULL DEFAULT 0,
      extraction JSONB,
      checks JSONB,
      score NUMERIC(4,3),
      recommendation TEXT CHECK (recommendation IN ('recommend_approve','needs_human_review','recommend_reject')),
      explanation JSONB,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX verification_milestone ON verification_runs (milestone_id, started_at DESC);` },
  { id: '005_safeguards', sql: `
    -- separation of duties: who verified, who approved, and exactly which proof each decision was about
    ALTER TABLE users ADD COLUMN token_epoch INT NOT NULL DEFAULT 0;
    ALTER TABLE approvals ADD COLUMN proof_id UUID REFERENCES proofs(id);
    ALTER TABLE approvals ADD COLUMN proof_sha256 TEXT;
    ALTER TABLE milestones ADD COLUMN verified_by INT REFERENCES users(id);
    ALTER TABLE milestones ADD COLUMN verified_at TIMESTAMPTZ;
    ALTER TABLE milestones ADD COLUMN verified_proof_sha256 TEXT;
    ALTER TABLE milestones ADD COLUMN approved_by INT REFERENCES users(id);
    ALTER TABLE milestones ADD COLUMN approved_at TIMESTAMPTZ;
    ALTER TABLE milestones ADD COLUMN disputed_at TIMESTAMPTZ;
    ALTER TABLE milestones ADD COLUMN dispute_note TEXT;
    -- demo clock is per case (never global)
    ALTER TABLE cases ADD COLUMN clock_offset_days INT NOT NULL DEFAULT 0 CHECK (clock_offset_days BETWEEN 0 AND 60);
    -- cross-case proof reuse registry
    CREATE TABLE proof_registry (
      id BIGSERIAL PRIMARY KEY,
      proof_id UUID NOT NULL UNIQUE REFERENCES proofs(id),
      milestone_id UUID NOT NULL REFERENCES milestones(id),
      case_id UUID NOT NULL REFERENCES cases(id),
      sha256 TEXT NOT NULL,
      receipt_number TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX proof_registry_sha ON proof_registry (sha256);
    CREATE INDEX proof_registry_receipt ON proof_registry (receipt_number) WHERE receipt_number IS NOT NULL;` },
];

export async function migrate(db: Db): Promise<string[]> {
  const applied: string[] = [];
  const c = await db.pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)'); // one migrator at a time (e.g. during zero-downtime deploys)
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT id FROM schema_migrations')).rows.map(r => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      try {
        await c.query('BEGIN'); await c.query(m.sql);
        await c.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]); await c.query('COMMIT');
        applied.push(m.id);
      } catch (e) { await c.query('ROLLBACK'); throw new Error(`migration ${m.id} failed: ${(e as Error).message}`); }
    }
  } finally { try { await c.query('SELECT pg_advisory_unlock(727001)'); } catch {} c.release(); }
  return applied;
}
