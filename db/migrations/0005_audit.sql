-- =====================================================================
-- 0005_audit  (runs as migrator)
-- K-07: append-only audit log with a per-tenant SHA-256 hash chain.
-- Table shape follows SAD §14.5 verbatim.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION migrator;
-- USAGE lets a role *call* a function in the schema; it grants no table access.
GRANT USAGE ON SCHEMA audit TO migrator, app_sample, app_relay, app_audit_chainer, reporting_reader;

-- Monthly partition helper. Called by audit.append() before every insert, so a
-- row dated into a month with no partition never fails (K07-T12) and the default
-- partition problem (rows stranded in DEFAULT, blocking later ATTACH) is avoided.
CREATE OR REPLACE FUNCTION audit.ensure_month_partition(p_ts timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, public
AS $$
DECLARE
  v_start date := date_trunc('month', p_ts)::date;
  v_end   date := (date_trunc('month', p_ts) + interval '1 month')::date;
  v_name  text := 'audit_entry_' || to_char(v_start, 'YYYYMM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'audit' AND c.relname = v_name) THEN
    EXECUTE format(
      'CREATE TABLE audit.%I PARTITION OF audit.audit_entry FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS audit.audit_entry (
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  tenant_id      uuid,
  actor_id       uuid,
  actor_role     text,
  action         text NOT NULL,
  resource_type  text,
  resource_id    uuid,
  purpose        text,
  correlation_id text,
  details        jsonb,
  chain_pos      bigint,
  prev_hash      bytea,
  entry_hash     bytea,
  PRIMARY KEY (occurred_at, seq)
) PARTITION BY RANGE (occurred_at);

-- Indexes lead with the chain key so chain_pending() never sorts.
CREATE INDEX IF NOT EXISTS audit_entry_chain_idx
  ON audit.audit_entry (tenant_id, seq) WHERE chain_pos IS NULL;
CREATE INDEX IF NOT EXISTS audit_entry_tenant_idx
  ON audit.audit_entry (tenant_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- K07-T11: canonical form. jsonb already normalises key order, so its text
-- representation is a stable, order-independent serialisation.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.canonical(p jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT coalesce(p, 'null'::jsonb)::text $$;

-- The business body of a row, without the chain columns.
CREATE OR REPLACE FUNCTION audit.canonical_entry(r audit.audit_entry)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT audit.canonical(jsonb_build_object(
    'seq', r.seq,
    'occurred_at', to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'tenant_id', r.tenant_id,
    'actor_id', r.actor_id,
    'actor_role', r.actor_role,
    'action', r.action,
    'resource_type', r.resource_type,
    'resource_id', r.resource_id,
    'purpose', r.purpose,
    'correlation_id', r.correlation_id,
    'details', r.details
  ))
$$;

-- ---------------------------------------------------------------------
-- K07-T01/T02/T05: append inside the caller's transaction.
-- SECURITY DEFINER so app_* roles never receive SELECT/INSERT on the table.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.append(
  p_action        text,
  p_resource_type text DEFAULT NULL,
  p_resource_id   uuid DEFAULT NULL,
  p_purpose       text DEFAULT NULL,
  p_details       jsonb DEFAULT NULL,
  p_actor_role    text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, public
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  v_actor  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_corr   text := NULLIF(current_setting('app.correlation_id', true), '');
  v_seq    bigint;
BEGIN
  IF p_action IS NULL OR btrim(p_action) = '' THEN
    RAISE EXCEPTION 'audit.append requires an action';
  END IF;

  PERFORM audit.ensure_month_partition(now());

  INSERT INTO audit.audit_entry
    (tenant_id, actor_id, actor_role, action, resource_type, resource_id,
     purpose, correlation_id, details)
  VALUES
    (v_tenant, v_actor, p_actor_role, p_action, p_resource_type, p_resource_id,
     p_purpose, v_corr, p_details)
  RETURNING seq INTO v_seq;

  RETURN v_seq;
END $$;

-- ---------------------------------------------------------------------
-- K07-T06..T08: seal pending entries into the hash chain.
-- Advisory xact lock per chain serialises concurrent runs; only NULL-chain
-- rows are touched, so two simultaneous callers stay safe.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.chain_pending(p_tenant uuid, p_limit int DEFAULT 1000)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, public
AS $$
DECLARE
  r        audit.audit_entry;
  v_prev   bytea;
  v_pos    bigint;
  v_count  int := 0;
  v_key    bigint;
BEGIN
  -- One lock per chain: tenant uuid, or the global/owner chain when NULL.
  v_key := hashtextextended('audit.chain:' || coalesce(p_tenant::text, 'OWNER'), 0);
  PERFORM pg_advisory_xact_lock(v_key);

  SELECT entry_hash, chain_pos INTO v_prev, v_pos
    FROM audit.audit_entry
   WHERE tenant_id IS NOT DISTINCT FROM p_tenant AND chain_pos IS NOT NULL
   ORDER BY chain_pos DESC
   LIMIT 1;

  IF NOT FOUND THEN
    v_prev := ''::bytea;
    v_pos  := 0;
  END IF;

  -- Mark this session as the chainer so the mutation guard permits the fill.
  PERFORM set_config('audit.chaining', 'on', true);

  FOR r IN
    SELECT * FROM audit.audit_entry
     WHERE tenant_id IS NOT DISTINCT FROM p_tenant AND chain_pos IS NULL
     ORDER BY seq
     LIMIT p_limit
     FOR UPDATE
  LOOP
    v_pos := v_pos + 1;
    UPDATE audit.audit_entry
       SET chain_pos  = v_pos,
           prev_hash  = v_prev,
           entry_hash = sha256(v_prev || convert_to(audit.canonical_entry(r), 'UTF8'))
     WHERE occurred_at = r.occurred_at AND seq = r.seq
     RETURNING entry_hash INTO v_prev;

    v_count := v_count + 1;
  END LOOP;

  PERFORM set_config('audit.chaining', 'off', true);
  RETURN v_count;
END $$;

-- ---------------------------------------------------------------------
-- K07-T09/T10: verify a chain segment.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.verify_chain(
  p_tenant uuid,
  p_from   bigint DEFAULT NULL,
  p_to     bigint DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, public
AS $$
DECLARE
  r      audit.audit_entry;
  v_prev bytea := NULL;
  v_pos  bigint := 0;
  v_exp  bytea;
BEGIN
  FOR r IN
    SELECT * FROM audit.audit_entry
     WHERE tenant_id IS NOT DISTINCT FROM p_tenant
       AND chain_pos IS NOT NULL
       AND (p_from IS NULL OR chain_pos >= p_from)
       AND (p_to   IS NULL OR chain_pos <= p_to)
     ORDER BY chain_pos
  LOOP
    IF v_pos = 0 THEN
      v_prev := ''::bytea;
      v_pos := r.chain_pos;
    END IF;

    IF r.chain_pos <> v_pos THEN
      RETURN 'BROKEN:' || r.chain_pos;
    END IF;

    IF r.prev_hash IS DISTINCT FROM v_prev THEN
      RETURN 'BROKEN:' || r.chain_pos;
    END IF;

    v_exp := sha256(v_prev || convert_to(audit.canonical_entry(r), 'UTF8'));
    IF r.entry_hash IS DISTINCT FROM v_exp THEN
      RETURN 'BROKEN:' || r.chain_pos;
    END IF;

    v_prev := r.entry_hash;
    v_pos  := v_pos + 1;
  END LOOP;

  RETURN 'OK';
END $$;

-- ---------------------------------------------------------------------
-- K07-T03/T10: append-only guard. UPDATE is allowed only when a chainer is
-- filling the three chain columns from NULL; everything else is refused, for
-- every role including the owner.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('audit.chaining', true) = 'on'
     AND OLD.chain_pos IS NULL
     AND NEW.chain_pos IS NOT NULL
     AND (to_jsonb(OLD) - 'chain_pos' - 'prev_hash' - 'entry_hash')
       = (to_jsonb(NEW) - 'chain_pos' - 'prev_hash' - 'entry_hash')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit.audit_entry is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS audit_entry_immutable ON audit.audit_entry;
CREATE TRIGGER audit_entry_immutable
  BEFORE UPDATE OR DELETE ON audit.audit_entry
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- ---------------------------------------------------------------------
-- Privileges: no table access for application roles, functions only.
-- ---------------------------------------------------------------------
REVOKE ALL ON audit.audit_entry FROM PUBLIC;
GRANT SELECT ON audit.audit_entry TO reporting_reader;
GRANT SELECT, INSERT, UPDATE ON audit.audit_entry TO migrator;

GRANT EXECUTE ON FUNCTION audit.append(text, text, uuid, text, jsonb, text)
  TO app_sample, app_relay;
GRANT EXECUTE ON FUNCTION audit.chain_pending(uuid, int) TO app_audit_chainer, migrator;
GRANT EXECUTE ON FUNCTION audit.verify_chain(uuid, bigint, bigint) TO reporting_reader, migrator;
GRANT EXECUTE ON FUNCTION audit.canonical(jsonb) TO app_audit_chainer, reporting_reader, migrator;

-- K07 read isolation.
-- ENABLE without FORCE: app roles are filtered by the policy, while the owner
-- (migrator) bypasses it. That bypass is required, not a loophole: the chain
-- functions are SECURITY DEFINER owned by migrator and must read every tenant's
-- unsealed rows. Tamper protection does not rely on RLS at all - it comes from
-- the immutable/truncate triggers, which fire for the owner and for superusers.
ALTER TABLE audit.audit_entry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit.audit_entry;
CREATE POLICY tenant_isolation ON audit.audit_entry
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- app_sample may not create partitions; the append function does it internally.
REVOKE ALL ON FUNCTION audit.ensure_month_partition(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.ensure_month_partition(timestamptz) TO migrator;

-- Seed partitions for the current and next month.
SELECT audit.ensure_month_partition(now());
SELECT audit.ensure_month_partition(now() + interval '1 month');
