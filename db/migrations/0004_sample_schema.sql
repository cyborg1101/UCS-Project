-- =====================================================================
-- 0004_sample_schema  (runs as migrator)
-- The generated shape of a business module: K-05 (RLS), K-08 (outbox),
-- K-09 (inbox/offset/dlq), K-10 (idempotency). Every later module is a
-- copy of this structure, produced by tools/generators/module.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS sample AUTHORIZATION owner_sample;

GRANT USAGE ON SCHEMA sample TO app_sample, app_relay, reporting_reader;

-- ---------------------------------------------------------------------
-- Business table (K05-*)
-- ---------------------------------------------------------------------
CREATE TABLE sample.item (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  public_id   text NOT NULL,
  name        text NOT NULL,
  seq         bigint NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_public_id_unique UNIQUE (tenant_id, public_id)
);

-- K05-T09: every business index starts with tenant_id.
CREATE INDEX item_tenant_created_idx ON sample.item (tenant_id, created_at DESC);
CREATE INDEX item_tenant_seq_idx     ON sample.item (tenant_id, seq);

ALTER TABLE sample.item ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.item FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sample.item
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- Outbox (K08): written inside the business transaction
-- ---------------------------------------------------------------------
CREATE TABLE sample.outbox (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  aggregate_seq  bigint NOT NULL,
  event_type     text NOT NULL,
  event_version  int  NOT NULL DEFAULT 1,
  payload        jsonb NOT NULL,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  causation_id   uuid,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  CONSTRAINT outbox_aggregate_seq_unique UNIQUE (aggregate_id, aggregate_seq)
);

CREATE INDEX outbox_unpublished_idx ON sample.outbox (tenant_id, aggregate_id, aggregate_seq)
  WHERE published_at IS NULL;

ALTER TABLE sample.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sample.outbox
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Monotonic per-aggregate sequence, serialised by a row lock (K08-T04).
CREATE TABLE sample.aggregate_sequence (
  aggregate_id uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  last_seq     bigint NOT NULL DEFAULT 0
);
ALTER TABLE sample.aggregate_sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.aggregate_sequence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sample.aggregate_sequence
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- Consumer state (K09)
-- ---------------------------------------------------------------------
CREATE TABLE sample.inbox (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  tenant_id    uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
ALTER TABLE sample.inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sample.inbox
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE sample.offset (
  consumer   text PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  log_seq    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sample.offset ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.offset FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sample.offset
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE sample.dead_letter (
  id            uuid PRIMARY KEY,
  consumer      text NOT NULL,
  event_id      uuid NOT NULL,
  tenant_id     uuid NOT NULL,
  aggregate_id  uuid,
  aggregate_seq bigint,
  payload       jsonb,
  error         text NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  skipped_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dlq_unique UNIQUE (consumer, event_id)
);
ALTER TABLE sample.dead_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.dead_letter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sample.dead_letter
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- Idempotency (K10)
-- ---------------------------------------------------------------------
CREATE TABLE sample.idempotency_key (
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status       text NOT NULL DEFAULT 'IN_PROGRESS',
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '48 hours',
  PRIMARY KEY (tenant_id, user_id, key)
);
ALTER TABLE sample.idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.idempotency_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sample.idempotency_key
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  sample.item, sample.outbox, sample.aggregate_sequence,
  sample.inbox, sample.offset, sample.dead_letter, sample.idempotency_key
  TO app_sample;
GRANT SELECT, INSERT ON sample.item TO reporting_reader;

-- =====================================================================
-- Functions
-- =====================================================================

-- Next aggregate sequence: row lock serialises concurrent appends (K08-T04).
CREATE OR REPLACE FUNCTION sample.next_aggregate_seq(p_aggregate_id uuid, p_tenant_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = sample, public
AS $$
DECLARE
  v_seq bigint;
BEGIN
  INSERT INTO sample.aggregate_sequence (aggregate_id, tenant_id, last_seq)
  VALUES (p_aggregate_id, p_tenant_id, 1)
  ON CONFLICT (aggregate_id) DO UPDATE
    SET last_seq = sample.aggregate_sequence.last_seq + 1
  RETURNING last_seq INTO v_seq;
  RETURN v_seq;
END $$;

-- Relay read path: SECURITY DEFINER so app_relay never gains table SELECT (K08-T05).
CREATE OR REPLACE FUNCTION sample.outbox_fetch(p_limit int)
RETURNS TABLE (
  id uuid, tenant_id uuid, aggregate_type text, aggregate_id uuid,
  aggregate_seq bigint, event_type text, event_version int,
  payload jsonb, metadata jsonb, correlation_id text, causation_id uuid,
  occurred_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  SELECT o.id, o.tenant_id, o.aggregate_type, o.aggregate_id,
         o.aggregate_seq, o.event_type, o.event_version,
         o.payload, o.metadata, o.correlation_id, o.causation_id, o.occurred_at
    FROM sample.outbox o
   WHERE o.published_at IS NULL
   ORDER BY o.aggregate_id, o.aggregate_seq
   LIMIT p_limit
   FOR UPDATE SKIP LOCKED
$$;

CREATE OR REPLACE FUNCTION sample.outbox_ack(p_ids uuid[])
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  WITH ack AS (
    UPDATE sample.outbox SET published_at = now()
     WHERE id = ANY(p_ids) AND published_at IS NULL
     RETURNING 1
  )
  SELECT count(*)::int FROM ack
$$;

-- DLQ replay for one aggregate (K09-T09).
CREATE OR REPLACE FUNCTION sample.dlq_replay_aggregate(p_consumer text, p_aggregate_id uuid)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  WITH cleared AS (
    DELETE FROM sample.dead_letter
     WHERE consumer = p_consumer AND aggregate_id = p_aggregate_id AND skipped_reason IS NULL
     RETURNING 1
  )
  SELECT count(*)::int FROM cleared
$$;

-- DLQ skip requires a textual reason (K09-T10).
CREATE OR REPLACE FUNCTION sample.dlq_skip(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = sample, public
AS $$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'dlq_skip requires a reason';
  END IF;
  UPDATE sample.dead_letter
     SET skipped_reason = p_reason
   WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dead_letter % not found', p_id;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION sample.next_aggregate_seq(uuid, uuid) TO app_sample;
GRANT EXECUTE ON FUNCTION sample.outbox_fetch(int)                TO app_relay;
GRANT EXECUTE ON FUNCTION sample.outbox_ack(uuid[])               TO app_relay;
GRANT EXECUTE ON FUNCTION sample.dlq_replay_aggregate(text, uuid) TO app_sample, app_relay;
GRANT EXECUTE ON FUNCTION sample.dlq_skip(uuid, text)             TO app_sample, app_relay;
