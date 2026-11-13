-- =====================================================================
-- 0006_messaging  (runs as migrator)
-- K-08: global ordered event log, gap-free counter, single-writer lease.
-- K-09: consumer subscriptions and read path.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS messaging AUTHORIZATION migrator;
GRANT USAGE ON SCHEMA messaging TO app_relay, app_sample;

-- ---------------------------------------------------------------------
-- G1: gap-free sequence from a counter row, never a Sequence.
-- A Sequence is non-transactional: a rollback burns a value and leaves a gap.
-- An UPDATE ... RETURNING on a single row takes a row lock and rolls back with
-- the transaction, so log_seq is dense (K08-T08).
-- ---------------------------------------------------------------------
CREATE TABLE messaging.log_counter (
  id       int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_seq bigint NOT NULL DEFAULT 0
);
INSERT INTO messaging.log_counter (id, last_seq) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- The log itself. Partitioned monthly (SAD §9); the PK includes the partition
-- key as PostgreSQL requires. Global uniqueness of log_seq is guaranteed by
-- the counter, not by an index.
-- ---------------------------------------------------------------------
CREATE TABLE messaging.event_log (
  log_seq        bigint NOT NULL,
  event_id       uuid NOT NULL,
  tenant_id      uuid NOT NULL,
  producer       text NOT NULL,
  event_type     text NOT NULL,
  event_version  int NOT NULL DEFAULT 1,
  aggregate_type text,
  aggregate_id   uuid,
  aggregate_seq  bigint,
  payload        jsonb NOT NULL,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  causation_id   uuid,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recorded_at, log_seq)
) PARTITION BY RANGE (recorded_at);

CREATE OR REPLACE FUNCTION messaging.ensure_month_partition(p_ts timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = messaging, public
AS $$
DECLARE
  v_start date := date_trunc('month', p_ts)::date;
  v_end   date := (date_trunc('month', p_ts) + interval '1 month')::date;
  v_name  text := 'event_log_' || to_char(v_start, 'YYYYMM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'messaging' AND c.relname = v_name) THEN
    EXECUTE format(
      'CREATE TABLE messaging.%I PARTITION OF messaging.event_log FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end);
  END IF;
END $$;

CREATE INDEX event_log_tenant_idx ON messaging.event_log (tenant_id, log_seq);
CREATE INDEX event_log_type_idx   ON messaging.event_log (event_type, log_seq);
CREATE INDEX event_log_agg_idx    ON messaging.event_log (tenant_id, aggregate_id, aggregate_seq);

-- ---------------------------------------------------------------------
-- Dedup: relay retries may re-send events already appended (K08-T07).
-- ---------------------------------------------------------------------
CREATE TABLE messaging.event_dedup (
  event_id   uuid PRIMARY KEY,
  log_seq    bigint NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Single-writer lease with a fencing epoch (E-03/E-04, K08-T12).
-- ---------------------------------------------------------------------
CREATE TABLE messaging.writer_lease (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  epoch      bigint NOT NULL DEFAULT 0,
  owner      text,
  acquired_at timestamptz,
  expires_at timestamptz
);
INSERT INTO messaging.writer_lease (id, epoch) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE messaging.subscription (
  consumer   text NOT NULL,
  event_type text NOT NULL,
  PRIMARY KEY (consumer, event_type)
);

-- =====================================================================
-- append_events: the single write path into the log.
--   * locks the lease row, so a leader that lost the lease is rejected the
--     moment it tries to write, even if its own clock or memory is stale;
--   * takes log_seq from the counter row, so values are dense;
--   * dedups by event_id.
-- Returns how many events were appended.
-- =====================================================================
CREATE OR REPLACE FUNCTION messaging.relay_batch(p_epoch bigint, p_events jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = messaging, public
AS $$
DECLARE
  v_lease   messaging.writer_lease;
  v_seq     bigint;
  v_count   int := 0;
  e         jsonb;
  v_inserted int;
BEGIN
  -- FOR UPDATE serialises every would-be writer and makes fencing exact.
  SELECT * INTO v_lease FROM messaging.writer_lease WHERE id = 1 FOR UPDATE;

  IF v_lease.epoch <> p_epoch THEN
    RAISE EXCEPTION 'stale epoch % (current %)', p_epoch, v_lease.epoch
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_lease.expires_at IS NULL OR v_lease.expires_at < now() THEN
    RAISE EXCEPTION 'writer lease expired'
      USING ERRCODE = 'serialization_failure';
  END IF;

  PERFORM messaging.ensure_month_partition(now());

  FOR e IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    INSERT INTO messaging.event_dedup (event_id, log_seq)
    VALUES ((e->>'event_id')::uuid, 0)
    ON CONFLICT (event_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 0 THEN
      CONTINUE;  -- already appended by an earlier delivery
    END IF;

    UPDATE messaging.log_counter SET last_seq = last_seq + 1
     WHERE id = 1 RETURNING last_seq INTO v_seq;

    INSERT INTO messaging.event_log (
      log_seq, event_id, tenant_id, producer, event_type, event_version,
      aggregate_type, aggregate_id, aggregate_seq, payload, metadata,
      correlation_id, causation_id, occurred_at)
    VALUES (
      v_seq,
      (e->>'event_id')::uuid,
      (e->>'tenant_id')::uuid,
      e->>'producer',
      e->>'event_type',
      coalesce((e->>'event_version')::int, 1),
      e->>'aggregate_type',
      (e->>'aggregate_id')::uuid,
      (e->>'aggregate_seq')::bigint,
      e->'payload',
      coalesce(e->'metadata', '{}'::jsonb),
      e->>'correlation_id',
      (e->>'causation_id')::uuid,
      (e->>'occurred_at')::timestamptz);

    UPDATE messaging.event_dedup SET log_seq = v_seq WHERE event_id = (e->>'event_id')::uuid;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

-- ---------------------------------------------------------------------
-- Lease acquire/renew. Acquire bumps the epoch, fencing out the old leader.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messaging.acquire_lease(p_owner text, p_ttl_seconds int DEFAULT 15)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = messaging, public
AS $$
DECLARE
  v_epoch bigint;
BEGIN
  UPDATE messaging.writer_lease
     SET epoch = epoch + 1,
         owner = p_owner,
         acquired_at = now(),
         expires_at = now() + make_interval(secs => p_ttl_seconds)
   WHERE id = 1
     AND (expires_at IS NULL OR expires_at < now() OR owner = p_owner)
  RETURNING epoch INTO v_epoch;

  RETURN v_epoch;  -- NULL when another live leader holds the lease
END $$;

CREATE OR REPLACE FUNCTION messaging.renew_lease(p_epoch bigint, p_ttl_seconds int DEFAULT 15)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = messaging, public
AS $$
  WITH r AS (
    UPDATE messaging.writer_lease
       SET expires_at = now() + make_interval(secs => p_ttl_seconds)
     WHERE id = 1 AND epoch = p_epoch AND expires_at > now()
     RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM r)
$$;

CREATE OR REPLACE FUNCTION messaging.release_lease(p_epoch bigint)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = messaging, public
AS $$
  UPDATE messaging.writer_lease SET expires_at = now() WHERE id = 1 AND epoch = p_epoch
$$;

-- Observability (K08-T14) and an explicit "who owns the log right now" probe.
-- Carries no write power, so it is safe to hand to every relay caller.
CREATE OR REPLACE FUNCTION messaging.current_epoch()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = messaging, public
AS $$
  SELECT epoch FROM messaging.writer_lease WHERE id = 1
$$;

-- ---------------------------------------------------------------------
-- Consumer read path (K09-T01).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messaging.read_subscribed(
  p_consumer text,
  p_after    bigint,
  p_limit    int
)
RETURNS TABLE (
  log_seq bigint, event_id uuid, tenant_id uuid, producer text, event_type text,
  event_version int, aggregate_type text, aggregate_id uuid, aggregate_seq bigint,
  payload jsonb, correlation_id text, causation_id uuid, occurred_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = messaging, public
AS $$
  SELECT e.log_seq, e.event_id, e.tenant_id, e.producer, e.event_type,
         e.event_version, e.aggregate_type, e.aggregate_id, e.aggregate_seq,
         e.payload, e.correlation_id, e.causation_id, e.occurred_at
    FROM messaging.event_log e
   WHERE e.log_seq > p_after
     AND EXISTS (SELECT 1 FROM messaging.subscription s
                  WHERE s.consumer = p_consumer AND s.event_type = e.event_type)
   ORDER BY e.log_seq
   LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION messaging.subscribe(p_consumer text, p_event_type text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = messaging, public
AS $$
  INSERT INTO messaging.subscription (consumer, event_type)
  VALUES (p_consumer, p_event_type) ON CONFLICT DO NOTHING
$$;

-- Head of the log (K09): a new consumer starts from "now" rather than replaying
-- all history, and tests need a deterministic starting point.
CREATE OR REPLACE FUNCTION messaging.max_log_seq()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = messaging, public
AS $$
  SELECT coalesce(max(log_seq), 0) FROM messaging.event_log
$$;

-- Metrics (K08-T14).
CREATE OR REPLACE FUNCTION messaging.outbox_unpublished_age(p_schema text)
RETURNS interval
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_age interval;
BEGIN
  EXECUTE format(
    'SELECT max(now() - occurred_at) FROM %I.outbox WHERE published_at IS NULL', p_schema)
    INTO v_age;
  RETURN coalesce(v_age, interval '0');
END $$;

-- ---------------------------------------------------------------------
-- Privileges: the log is relay-owned; no app role reads it directly.
-- ---------------------------------------------------------------------
REVOKE ALL ON messaging.event_log FROM PUBLIC;
GRANT SELECT, INSERT ON messaging.event_log TO migrator;
GRANT SELECT, INSERT ON messaging.log_counter TO migrator;
GRANT SELECT, INSERT, UPDATE ON messaging.event_dedup TO migrator;
GRANT SELECT, UPDATE ON messaging.writer_lease TO migrator;
GRANT SELECT, INSERT ON messaging.subscription TO migrator;

GRANT EXECUTE ON FUNCTION messaging.relay_batch(bigint, jsonb) TO app_relay;
GRANT EXECUTE ON FUNCTION messaging.acquire_lease(text, int) TO app_relay;
GRANT EXECUTE ON FUNCTION messaging.renew_lease(bigint, int) TO app_relay;
GRANT EXECUTE ON FUNCTION messaging.release_lease(bigint) TO app_relay;
GRANT EXECUTE ON FUNCTION messaging.read_subscribed(text, bigint, int) TO app_relay, app_sample;
GRANT EXECUTE ON FUNCTION messaging.subscribe(text, text) TO app_relay, app_sample;
GRANT EXECUTE ON FUNCTION messaging.outbox_unpublished_age(text) TO app_relay;
GRANT EXECUTE ON FUNCTION messaging.max_log_seq() TO app_sample, app_relay;

SELECT messaging.ensure_month_partition(now());
SELECT messaging.ensure_month_partition(now() + interval '1 month');
