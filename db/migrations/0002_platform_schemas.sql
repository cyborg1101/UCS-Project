-- =====================================================================
-- 0002_platform_schemas  (runs as migrator)
-- K02-T03, K02-T04: close PUBLIC, create platform schemas.
-- =====================================================================

-- K02-T03: no implicit access for PUBLIC.
REVOKE ALL ON DATABASE ucs FROM PUBLIC;
GRANT CONNECT ON DATABASE ucs TO migrator, app_sample, app_relay, app_audit_chainer, reporting_reader;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'platform') THEN
    EXECUTE 'CREATE SCHEMA platform AUTHORIZATION migrator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'audit') THEN
    EXECUTE 'CREATE SCHEMA audit AUTHORIZATION migrator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'messaging') THEN
    EXECUTE 'CREATE SCHEMA messaging AUTHORIZATION migrator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'kernel') THEN
    EXECUTE 'CREATE SCHEMA kernel AUTHORIZATION migrator';
  END IF;
END $$;

-- Schemas are not usable by PUBLIC (K02-T03).
REVOKE ALL ON SCHEMA platform  FROM PUBLIC;
REVOKE ALL ON SCHEMA audit     FROM PUBLIC;
REVOKE ALL ON SCHEMA messaging FROM PUBLIC;
REVOKE ALL ON SCHEMA kernel    FROM PUBLIC;

-- CREATE requires ownership; USAGE requires an explicit grant per role.
GRANT USAGE ON SCHEMA kernel TO migrator, app_relay, app_audit_chainer;

-- pgcrypto: sha256/digest for the audit hash chain (SAD §14.5).
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO migrator;

-- Migrator owns everything it creates from here on.
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA platform  GRANT ALL ON TABLES TO migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA audit     GRANT ALL ON TABLES TO migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA messaging GRANT ALL ON TABLES TO migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA kernel    GRANT ALL ON TABLES TO migrator;
