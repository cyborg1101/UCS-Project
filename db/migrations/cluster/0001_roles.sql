-- =====================================================================
-- 0001_roles  (cluster level, runs as superuser)
-- K02-T01, K02-T02, K02-T05
-- =====================================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- name,               canlogin, connlimit  (SAD §10.4 pool_size)
      ('migrator',           true,     8),
      ('owner_sample',       false,   -1),  -- NOLOGIN: owns schema objects
      ('app_sample',         true,     3),
      ('app_relay',          true,     1),
      ('app_audit_chainer',  true,     1),
      ('reporting_reader',   true,     4),
      ('relay_reader',       false,   -1), -- NOLOGIN owner of relay functions
      ('consumer_reader',    false,   -1)  -- NOLOGIN owner of consumer-state functions
    ) AS t(name, canlogin, connlimit)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format(
        'CREATE ROLE %I %s CONNECTION LIMIT %s',
        r.name,
        CASE WHEN r.canlogin THEN 'LOGIN' ELSE 'NOLOGIN' END,
        r.connlimit
      );
    END IF;
  END LOOP;
END $$;

-- K02-T02: no role may bypass RLS or be superuser; owners stay NOLOGIN.
ALTER ROLE migrator          NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN  CONNECTION LIMIT 8;
ALTER ROLE owner_sample      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
ALTER ROLE app_sample        NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN  CONNECTION LIMIT 3;
ALTER ROLE app_relay         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN  CONNECTION LIMIT 1;
ALTER ROLE app_audit_chainer NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN  CONNECTION LIMIT 1;
ALTER ROLE reporting_reader  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN  CONNECTION LIMIT 4;
ALTER ROLE relay_reader      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
ALTER ROLE consumer_reader   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;

-- migrator must be able to create objects owned by the module owner and to
-- reassign ownership to the relay function owner.
GRANT owner_sample TO migrator;
GRANT relay_reader TO migrator;
GRANT consumer_reader TO migrator;
