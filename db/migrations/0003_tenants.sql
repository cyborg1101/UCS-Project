-- =====================================================================
-- 0003_tenants  (runs as migrator)
-- Minimal tenant registry so RLS can be exercised end to end.
-- The full tenancy module arrives in Phase 1; this is the Kernel contract:
-- every tenant has a stable uuid and a 2-letter public code.
-- =====================================================================
CREATE TABLE IF NOT EXISTS platform.tenant (
  id           uuid PRIMARY KEY,
  code         char(2) NOT NULL UNIQUE,
  name_ar      text NOT NULL,
  name_en      text,
  status       text NOT NULL DEFAULT 'ACTIVE',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_code_upper CHECK (code = upper(code))
);

-- Not tenant-scoped itself: tenants are the root of isolation, so there is no
-- tenant_id column to filter on. ENABLE (without FORCE) means the owner
-- (migrator) may write it while every app role still goes through the
-- read-only policy below. FORCE is reserved for tenant-scoped tables.
ALTER TABLE platform.tenant ENABLE ROW LEVEL SECURITY;

-- Anyone may resolve the tenant directory; no app role may write it.
DROP POLICY IF EXISTS tenant_read ON platform.tenant;
CREATE POLICY tenant_read ON platform.tenant FOR SELECT USING (true);

-- USAGE on the schema is a separate privilege from SELECT on the table:
-- without it the table grant is unreachable ("permission denied for
-- schema platform"). Every app role resolves the tenant directory to map
-- the caller's tenant_id to its public code, so it needs both.
GRANT USAGE ON SCHEMA platform TO app_sample, app_relay, reporting_reader;
GRANT SELECT ON platform.tenant TO app_sample, app_relay, reporting_reader;
GRANT SELECT, INSERT, UPDATE ON platform.tenant TO migrator;

-- Seed the two tenants used by the test suite (SAD Phase0 §2.4).
INSERT INTO platform.tenant (id, code, name_ar, name_en) VALUES
  ('00000000-0000-7000-8000-0000000000aa', 'AA', 'جامعة ألفا', 'Alpha University'),
  ('00000000-0000-7000-8000-0000000000bb', 'BB', 'جامعة بيتا', 'Beta University')
ON CONFLICT (id) DO NOTHING;
