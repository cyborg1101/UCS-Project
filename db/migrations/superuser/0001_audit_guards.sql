-- =====================================================================
-- superuser/0001_audit_guards  (runs as superuser against the app database)
-- K07-T03/T04: audit.audit_entry is append-only for every role.
--
-- Two guards:
--   1. a statement-level BEFORE TRUNCATE trigger (event triggers have no
--      TRUNCATE event, so the trigger is the only mechanism that works);
--   2. an sql_drop event trigger refusing DROP/DETACH of any audit object.
-- UPDATE/DELETE are blocked per-row by audit.forbid_mutation() (0005).
-- =====================================================================

CREATE OR REPLACE FUNCTION audit.forbid_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit.audit_entry is append-only (TRUNCATE rejected)'
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS audit_entry_no_truncate ON audit.audit_entry;
CREATE TRIGGER audit_entry_no_truncate
  BEFORE TRUNCATE ON audit.audit_entry
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_truncate();

-- Same guard on each existing partition: TRUNCATE audit.audit_entry_202611
-- would otherwise bypass the parent trigger (triggers are not inherited).
DO $$
DECLARE
  part record;
BEGIN
  FOR part IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace pn ON pn.oid = p.relnamespace
     WHERE pn.nspname = 'audit' AND p.relname = 'audit_entry'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS audit_entry_no_truncate ON audit.%I;
       CREATE TRIGGER audit_entry_no_truncate BEFORE TRUNCATE ON audit.%I
       FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_truncate();',
      part.relname, part.relname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- DROP / DETACH protection.
-- sql_drop reports through pg_event_trigger_dropped_objects(), not
-- pg_event_trigger_ddl_commands().
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.forbid_audit_drop()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
    IF obj.schema_name = 'audit' THEN
      RAISE EXCEPTION 'audit schema is protected: dropping % is refused', obj.object_identity
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS audit_no_drop;
CREATE EVENT TRIGGER audit_no_drop
  ON sql_drop
  EXECUTE FUNCTION audit.forbid_audit_drop();
