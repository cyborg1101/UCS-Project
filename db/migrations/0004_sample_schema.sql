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
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR pg_has_role(current_user, 'relay_reader', 'member'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR pg_has_role(current_user, 'relay_reader', 'member'));

-- Monotonic per-aggregate sequence, serialised by a row lock (K08-T04).
CREATE TABLE sample.aggregate_sequence (
  aggregate_id uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  last_seq     bigint NOT NULL DEFAULT 0
);
CREATE INDEX aggregate_sequence_tenant_idx ON sample.aggregate_sequence (tenant_id);
ALTER TABLE sample.aggregate_sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.aggregate_sequence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sample.aggregate_sequence
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- Consumer state (K09)
-- ---------------------------------------------------------------------
CREATE TABLE sample.inbox (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL,
  tenant_id     uuid NOT NULL,
  -- K09-T05: needed to detect a gap in an aggregate's sequence.
  aggregate_id  uuid,
  aggregate_seq bigint,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
CREATE INDEX inbox_tenant_idx ON sample.inbox (tenant_id, processed_at DESC);
ALTER TABLE sample.inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.inbox FORCE ROW LEVEL SECURITY;
-- Consumer state is inherently cross-tenant: a consumer's cursor spans every
-- tenant's events. consumer_reader is NOLOGIN and reachable only through the
-- SECURITY DEFINER functions below, so this admits the consumer path and
-- nothing else (K09-T12).
CREATE POLICY tenant_isolation ON sample.inbox
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR pg_has_role(current_user, 'consumer_reader', 'member'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR pg_has_role(current_user, 'consumer_reader', 'member'));

CREATE TABLE sample.offset (
  consumer   text PRIMARY KEY,
  -- Nullable by design: a consumer cursor spans every tenant's events, so it
  -- belongs to no single tenant. RLS still guards the row (consumer_reader).
  tenant_id  uuid,
  log_seq    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offset_tenant_idx ON sample.offset (tenant_id);
ALTER TABLE sample.offset ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.offset FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sample.offset
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR pg_has_role(current_user, 'consumer_reader', 'member'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR pg_has_role(current_user, 'consumer_reader', 'member'));

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
  -- K09-T09: replay needs to rewind the offset to just before this event,
  -- otherwise the corrected handler never sees it again.
  log_seq       bigint,
  skipped_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dlq_unique UNIQUE (consumer, event_id)
);
CREATE INDEX dead_letter_tenant_idx ON sample.dead_letter (tenant_id, created_at DESC);
CREATE INDEX dead_letter_aggregate_idx ON sample.dead_letter (tenant_id, aggregate_id);
ALTER TABLE sample.dead_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.dead_letter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sample.dead_letter
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR pg_has_role(current_user, 'consumer_reader', 'member'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR pg_has_role(current_user, 'consumer_reader', 'member'));

-- ---------------------------------------------------------------------
-- Parked events (K09-T05, K09-T07).
-- A forward gap in aggregate_seq means the aggregate must not be applied yet.
-- Recording *why* and *since when* is what makes staleness alertable; a bare
-- counter inside the consumer process could never be observed by anything else.
-- ---------------------------------------------------------------------
CREATE TABLE sample.parked_event (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL,
  tenant_id     uuid NOT NULL,
  aggregate_id  uuid NOT NULL,
  aggregate_seq bigint NOT NULL,
  expected_seq  bigint NOT NULL,
  log_seq       bigint NOT NULL,
  parked_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
CREATE INDEX parked_event_tenant_idx ON sample.parked_event (tenant_id, parked_at);
CREATE INDEX parked_event_agg_idx ON sample.parked_event (consumer, aggregate_id, aggregate_seq);
ALTER TABLE sample.parked_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.parked_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sample.parked_event
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR pg_has_role(current_user, 'consumer_reader', 'member'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR pg_has_role(current_user, 'consumer_reader', 'member'));

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
  sample.inbox, sample.offset, sample.dead_letter, sample.idempotency_key,
  sample.parked_event
  TO app_sample;
GRANT SELECT, INSERT ON sample.item TO reporting_reader;

-- =====================================================================
-- Ownership: the module owner role owns its objects (SAD §9), and FORCE RLS
-- means even that owner is filtered by the tenant policy.
-- =====================================================================
ALTER TABLE sample.item               OWNER TO owner_sample;
ALTER TABLE sample.outbox             OWNER TO owner_sample;
ALTER TABLE sample.aggregate_sequence OWNER TO owner_sample;
ALTER TABLE sample.inbox              OWNER TO owner_sample;
ALTER TABLE sample.offset             OWNER TO owner_sample;
ALTER TABLE sample.dead_letter        OWNER TO owner_sample;
ALTER TABLE sample.idempotency_key    OWNER TO owner_sample;
ALTER TABLE sample.parked_event      OWNER TO owner_sample;

-- migrator still needs to create objects in the schema after the ownership
-- transfer above (functions and their owner reassignment follow).
GRANT ALL ON SCHEMA sample TO migrator;
GRANT ALL ON ALL TABLES IN SCHEMA sample TO migrator;

-- A new object owner must hold CREATE on the schema (PostgreSQL rule).
-- relay_reader is NOLOGIN: reachable only via SET ROLE by migrator.
GRANT USAGE, CREATE ON SCHEMA sample TO relay_reader;
GRANT USAGE, CREATE ON SCHEMA sample TO consumer_reader;

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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = sample, public
AS $$
DECLARE
  v_min_log bigint;
  v_count   int;
BEGIN
  SELECT min(log_seq) INTO v_min_log
    FROM sample.dead_letter
   WHERE consumer = p_consumer AND aggregate_id = p_aggregate_id AND skipped_reason IS NULL;

  IF v_min_log IS NULL THEN
    RETURN 0;
  END IF;

  WITH cleared AS (
    DELETE FROM sample.dead_letter
     WHERE consumer = p_consumer AND aggregate_id = p_aggregate_id AND skipped_reason IS NULL
     RETURNING 1
  )
  SELECT count(*)::int INTO v_count FROM cleared;

  -- K09-T09: rewind so the re-queued events are actually re-read, in log_seq
  -- order, after the fix.
  UPDATE sample.offset
     SET log_seq = v_min_log - 1, updated_at = now()
   WHERE consumer = p_consumer AND log_seq >= v_min_log;

  -- The aggregate is released, so anything previously parked for it is stale.
  DELETE FROM sample.parked_event
   WHERE consumer = p_consumer AND aggregate_id = p_aggregate_id;

  PERFORM audit.append('MESSAGING.DLQ_REPLAY', 'aggregate', p_aggregate_id, NULL,
                       jsonb_build_object('consumer', p_consumer, 'replayed', v_count));
  RETURN v_count;
END $$;

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
  -- K09-T10: skipping a dead letter is an operator override and must be
  -- attributable, so it appends to the audit chain in the same transaction.
  PERFORM audit.append('MESSAGING.DLQ_SKIP', 'dead_letter', p_id, NULL,
                       jsonb_build_object('reason', p_reason));
END $$;

-- =====================================================================
-- Consumer cursor (K09-T02/T04).
--
-- These five functions exist because consumer state is cross-tenant by nature:
-- the cursor spans every tenant's events, and it must be read *before* an event
-- (and therefore a tenant) is known. Reading sample.offset directly outside a
-- transaction leaves app.tenant_id unset, so FORCE RLS would filter every row
-- away and the cursor would silently stay at 0 forever. A NOLOGIN owner with a
-- narrow function surface keeps RLS intact instead of punching a hole in it.
-- =====================================================================
CREATE OR REPLACE FUNCTION sample.consumer_offset(p_consumer text)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  SELECT coalesce((SELECT log_seq FROM sample.offset WHERE consumer = p_consumer), 0)
$$;

CREATE OR REPLACE FUNCTION sample.consumer_ensure(p_consumer text, p_start_seq bigint DEFAULT 0)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  INSERT INTO sample.offset (consumer, log_seq) VALUES (p_consumer, p_start_seq)
  ON CONFLICT (consumer) DO NOTHING
$$;

CREATE OR REPLACE FUNCTION sample.consumer_advance(p_consumer text, p_log_seq bigint)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  UPDATE sample.offset SET log_seq = p_log_seq, updated_at = now()
   WHERE consumer = p_consumer AND log_seq < p_log_seq
$$;

CREATE OR REPLACE FUNCTION sample.consumer_rewind(p_consumer text, p_log_seq bigint)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  UPDATE sample.offset SET log_seq = p_log_seq, updated_at = now()
   WHERE consumer = p_consumer
$$;

-- Highest aggregate_seq this consumer has already applied, or NULL.
CREATE OR REPLACE FUNCTION sample.consumer_applied_seq(p_consumer text, p_aggregate_id uuid)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  SELECT max(aggregate_seq) FROM sample.inbox
   WHERE consumer = p_consumer AND aggregate_id = p_aggregate_id
$$;

CREATE OR REPLACE FUNCTION sample.consumer_seen(p_consumer text, p_event_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  SELECT EXISTS (SELECT 1 FROM sample.inbox
                  WHERE consumer = p_consumer AND event_id = p_event_id)
$$;

-- Record the effect of one event, append the inbox row and advance the cursor
-- as ONE statement chain inside the caller's transaction (G4 / E-07).
CREATE OR REPLACE FUNCTION sample.consumer_record(
  p_consumer     text,
  p_event_id     uuid,
  p_tenant_id    uuid,
  p_aggregate_id uuid,
  p_aggregate_seq bigint,
  p_log_seq      bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = sample, public
AS $$
BEGIN
  INSERT INTO sample.inbox (consumer, event_id, tenant_id, aggregate_id, aggregate_seq)
  VALUES (p_consumer, p_event_id, p_tenant_id, p_aggregate_id, p_aggregate_seq)
  ON CONFLICT (consumer, event_id) DO NOTHING;

  PERFORM sample.consumer_advance(p_consumer, p_log_seq);
  RETURN TRUE;
END $$;

-- Parked events reachable by the consumer process (cross-tenant), K09-T05/T07.
CREATE OR REPLACE FUNCTION sample.consumer_park(
  p_consumer text, p_event_id uuid, p_tenant_id uuid, p_aggregate_id uuid,
  p_aggregate_seq bigint, p_expected_seq bigint, p_log_seq bigint
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  INSERT INTO sample.parked_event
    (consumer, event_id, tenant_id, aggregate_id, aggregate_seq, expected_seq, log_seq)
  VALUES (p_consumer, p_event_id, p_tenant_id, p_aggregate_id, p_aggregate_seq, p_expected_seq, p_log_seq)
  ON CONFLICT (consumer, event_id) DO NOTHING
$$;

CREATE OR REPLACE FUNCTION sample.consumer_is_parked(p_consumer text, p_event_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  SELECT EXISTS (SELECT 1 FROM sample.parked_event
                  WHERE consumer = p_consumer AND event_id = p_event_id)
$$;

-- An event that has EXHAUSTED its attempts (or that an operator explicitly
-- skipped) and is therefore finished until someone acts on it. A mere failed
-- attempt is not enough: dead_letter holds a row from the very first failure
-- with attempts = 1, and treating that as final would stop the retries the
-- backoff contract promises. Hence the threshold, and the skipped_reason
-- escape hatch (dlq_skip means "do not run this again").
CREATE OR REPLACE FUNCTION sample.consumer_is_dead(
  p_consumer text, p_event_id uuid, p_max_attempts int
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  SELECT EXISTS (SELECT 1 FROM sample.dead_letter
                  WHERE consumer = p_consumer
                    AND event_id = p_event_id
                    AND (attempts >= p_max_attempts OR skipped_reason IS NOT NULL))
$$;

-- Followers of an aggregate that just had its hole filled: returns the earliest
-- log_seq among them and removes them, so the caller can rewind once.
CREATE OR REPLACE FUNCTION sample.consumer_release_followers(
  p_consumer text, p_aggregate_id uuid, p_after_seq bigint
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = sample, public
AS $$
DECLARE
  v_min bigint;
BEGIN
  SELECT min(log_seq) INTO v_min FROM sample.parked_event
   WHERE consumer = p_consumer AND aggregate_id = p_aggregate_id AND aggregate_seq > p_after_seq;

  IF v_min IS NULL THEN
    RETURN NULL;
  END IF;

  DELETE FROM sample.parked_event
   WHERE consumer = p_consumer AND aggregate_id = p_aggregate_id AND aggregate_seq > p_after_seq;

  RETURN v_min;
END $$;

CREATE OR REPLACE FUNCTION sample.consumer_dead_letter(
  p_consumer text, p_event_id uuid, p_tenant_id uuid, p_aggregate_id uuid,
  p_aggregate_seq bigint, p_payload jsonb, p_error text, p_log_seq bigint
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = sample, public
AS $$
DECLARE
  v_attempts int;
BEGIN
  INSERT INTO sample.dead_letter
    (id, consumer, event_id, tenant_id, aggregate_id, aggregate_seq,
     payload, error, attempts, log_seq)
  VALUES (gen_random_uuid(), p_consumer, p_event_id, p_tenant_id, p_aggregate_id,
          p_aggregate_seq, p_payload, p_error, 1, p_log_seq)
  ON CONFLICT (consumer, event_id)
  DO UPDATE SET attempts = sample.dead_letter.attempts + 1,
                error = p_error, log_seq = p_log_seq
  RETURNING attempts INTO v_attempts;
  RETURN v_attempts;
END $$;

-- Operational read paths for a consumer's own dead letters (K09-T09/T10/T11).
-- dead_letter is RLS-protected per tenant, but an operator process reasons per
-- *consumer*, not per tenant, so it cannot read the table directly. These are
-- the narrow doors: scoped by consumer, no business payloads beyond the error.
CREATE OR REPLACE FUNCTION sample.consumer_dead_letters(p_consumer text)
RETURNS TABLE (
  id uuid, event_id uuid, tenant_id uuid, aggregate_id uuid, aggregate_seq bigint,
  attempts int, log_seq bigint, error text, skipped_reason text, created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  SELECT d.id, d.event_id, d.tenant_id, d.aggregate_id, d.aggregate_seq,
         d.attempts, d.log_seq, d.error, d.skipped_reason, d.created_at
    FROM sample.dead_letter d
   WHERE d.consumer = p_consumer
   ORDER BY d.created_at
$$;

CREATE OR REPLACE FUNCTION sample.consumer_inbox_count(p_consumer text)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  SELECT count(*) FROM sample.inbox WHERE consumer = p_consumer
$$;

-- Operational view of parked aggregates (K09-T07).
-- parked_event is RLS-protected per tenant, so an operator process looking for
-- *any* stale aggregate cannot read the table directly. This SECURITY DEFINER
-- function is that one narrow, read-only door: it exposes only the staleness
-- facts for one consumer, never payloads or business rows.
CREATE OR REPLACE FUNCTION sample.parked_for_consumer(p_consumer text)
RETURNS TABLE (
  consumer text, aggregate_id uuid, aggregate_seq bigint, expected_seq bigint,
  parked_at timestamptz, age_seconds numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = sample, public
AS $$
  SELECT p.consumer, p.aggregate_id, p.aggregate_seq, p.expected_seq, p.parked_at,
         extract(epoch FROM now() - p.parked_at) AS age_seconds
    FROM sample.parked_event p
   WHERE p.consumer = p_consumer
   ORDER BY p.parked_at
$$;

-- Consumer-state functions run as consumer_reader (NOLOGIN, no BYPASSRLS);
-- pg_has_role in the policy admits exactly this path.
ALTER FUNCTION sample.consumer_offset(text)                       OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_ensure(text, bigint)               OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_advance(text, bigint)              OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_rewind(text, bigint)               OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_applied_seq(text, uuid)            OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_seen(text, uuid)                   OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_record(text, uuid, uuid, uuid, bigint, bigint) OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_park(text, uuid, uuid, uuid, bigint, bigint, bigint) OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_is_parked(text, uuid)              OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_is_dead(text, uuid, int)           OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_release_followers(text, uuid, bigint) OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_dead_letter(text, uuid, uuid, uuid, bigint, jsonb, text, bigint) OWNER TO consumer_reader;
ALTER FUNCTION sample.parked_for_consumer(text)                   OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_dead_letters(text)                 OWNER TO consumer_reader;
ALTER FUNCTION sample.consumer_inbox_count(text)                  OWNER TO consumer_reader;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  sample.inbox, sample.offset, sample.dead_letter, sample.parked_event
  TO consumer_reader;
GRANT EXECUTE ON FUNCTION
  sample.consumer_offset(text),
  sample.consumer_ensure(text, bigint),
  sample.consumer_advance(text, bigint),
  sample.consumer_rewind(text, bigint),
  sample.consumer_applied_seq(text, uuid),
  sample.consumer_seen(text, uuid),
  sample.consumer_record(text, uuid, uuid, uuid, bigint, bigint),
  sample.consumer_park(text, uuid, uuid, uuid, bigint, bigint, bigint),
  sample.consumer_is_parked(text, uuid),
  sample.consumer_is_dead(text, uuid, int),
  sample.consumer_release_followers(text, uuid, bigint),
  sample.consumer_dead_letter(text, uuid, uuid, uuid, bigint, jsonb, text, bigint),
  sample.parked_for_consumer(text),
  sample.consumer_dead_letters(text),
  sample.consumer_inbox_count(text)
  TO app_sample;

-- Relay functions run as relay_reader (NOLOGIN, no BYPASSRLS) which is a
-- member of itself, so pg_has_role inside the policy lets exactly this path
-- through - and nothing else.
ALTER FUNCTION sample.outbox_fetch(int)            OWNER TO relay_reader;
ALTER FUNCTION sample.outbox_ack(uuid[])           OWNER TO relay_reader;
-- Owned by migrator, like dlq_skip: it mutates consumer state AND appends to
-- the audit chain in the same transaction. migrator is a member of
-- consumer_reader (so the RLS policies admit its consumer-table writes) and
-- holds USAGE on audit (so the attribution cannot be silently dropped);
-- consumer_reader alone would fail at the audit write and roll back the
-- replay. consumer_reader is NOLOGIN, so nothing gains a login path here.
ALTER FUNCTION sample.dlq_replay_aggregate(text, uuid) OWNER TO migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON sample.outbox TO relay_reader;
GRANT SELECT, UPDATE ON sample.dead_letter TO relay_reader;

GRANT EXECUTE ON FUNCTION sample.next_aggregate_seq(uuid, uuid) TO app_sample;
GRANT EXECUTE ON FUNCTION sample.outbox_fetch(int)                TO app_relay;
GRANT EXECUTE ON FUNCTION sample.outbox_ack(uuid[])               TO app_relay;
GRANT EXECUTE ON FUNCTION sample.dlq_replay_aggregate(text, uuid) TO app_sample, app_relay;
GRANT EXECUTE ON FUNCTION sample.parked_for_consumer(text)        TO app_sample, app_relay;
GRANT EXECUTE ON FUNCTION sample.dlq_skip(uuid, text)             TO app_sample, app_relay;
