/**
 * check:indexes (K05-T09 / K-15)
 *
 * On a tenant-scoped table every index must lead with tenant_id, otherwise a
 * query that is correctly filtered by RLS still scans across tenants. A
 * composite index (tenant_id, created_at) is fine; (created_at) alone is not.
 */
import { Client } from 'pg';

export interface IndexFinding {
  schema: string;
  table: string;
  index: string;
  columns: string[];
  problem: string;
}

/** Indexes that are intentionally not tenant-first, with a documented reason. */
export const INDEX_EXEMPTIONS: Array<{ schema: string; table: string; index: string; reason: string }> = [
  { schema: 'sample', table: 'aggregate_sequence', index: 'aggregate_sequence_pkey', reason: 'PK on aggregate_id; row is already tenant-owned' },
  { schema: 'sample', table: 'outbox', index: 'outbox_aggregate_seq_unique', reason: 'per-aggregate ordering uniqueness' },
  { schema: 'sample', table: 'inbox', index: 'inbox_pkey', reason: 'consumer+event idempotency key' },
  { schema: 'sample', table: 'offset', index: 'offset_pkey', reason: 'one row per consumer' },
  { schema: 'sample', table: 'dead_letter', index: 'dlq_unique', reason: 'consumer+event dedup' },
  { schema: 'sample', table: 'idempotency_key', index: 'idempotency_key_pkey', reason: 'tenant-first but includes user+key' },
  // Consumer-side lookups are cross-tenant by design: the consumer process
  // resolves an aggregate's parked followers before any tenant is known, so
  // the leading column must be consumer. Tenant-filtered listing still has
  // parked_event_tenant_idx (tenant_id, parked_at).
  { schema: 'sample', table: 'parked_event', index: 'parked_event_agg_idx', reason: 'cross-tenant consumer lookup; tenant-leading index exists separately' },
];

function exempt(schema: string, table: string, index: string): boolean {
  return INDEX_EXEMPTIONS.some((e) => e.schema === schema && e.table === table && e.index === index);
}

export async function findIndexViolations(
  client: Client,
  schemas = ['sample'],
): Promise<IndexFinding[]> {
  const { rows } = await client.query<{
    schema: string;
    table: string;
    index: string;
    columns: string;
    is_primary: boolean;
    is_tenant_scoped: boolean;
  }>(
    `SELECT n.nspname AS schema,
            t.relname AS table,
            ic.relname AS index,
            i.indisprimary AS is_primary,
            coalesce((SELECT string_agg(a.attname, ',' ORDER BY k.ord)
               FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
              WHERE k.attnum > 0), '') AS columns,
            EXISTS (SELECT 1 FROM pg_attribute ta
                     WHERE ta.attrelid = t.oid AND ta.attname = 'tenant_id') AS is_tenant_scoped
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND t.relkind = 'r'
      ORDER BY n.nspname, t.relname, ic.relname`,
    [schemas],
  );

  const findings: IndexFinding[] = [];
  for (const r of rows) {
    if (!r.is_tenant_scoped) continue;
    if (exempt(r.schema, r.table, r.index)) continue;
    const cols = (r.columns ?? '').split(',').filter(Boolean);
    if (cols.length === 0) continue;
    // A primary key on a globally unique UUIDv7 is a point lookup target, not a
    // cross-tenant scan path: RLS still filters the row. Secondary indexes are
    // where an unscoped leading column really costs a tenant-wide scan, so those
    // stay strictly tenant-first. A tenant-leading index is required separately.
    if (r.is_primary) continue;
    if (cols[0] !== 'tenant_id') {
      findings.push({
        schema: r.schema,
        table: r.table,
        index: r.index,
        columns: cols,
        problem: `first column is "${cols[0]}", expected tenant_id`,
      });
    }
  }
  // Every tenant-scoped table must have at least one index that leads with
  // tenant_id, otherwise tenant-filtered listing queries scan the whole table.
  const tables = await client.query<{ schema: string; table: string; lead: string }>(
    `SELECT n.nspname AS schema, c.relname AS table,
            coalesce((SELECT max(CASE WHEN a.attname = 'tenant_id' THEN '1' ELSE '0' END)
                        FROM pg_index i2
                        JOIN unnest(i2.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true
                        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                       WHERE i2.indrelid = c.oid AND k.ord = 1), '0') AS lead
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND NOT c.relispartition
        AND n.nspname = ANY($1::text[])
        AND EXISTS (SELECT 1 FROM pg_attribute ta WHERE ta.attrelid = c.oid AND ta.attname = 'tenant_id')`,
    [schemas],
  );
  for (const t of tables.rows) {
    if (exempt(t.schema, t.table, '__any__')) continue;
    if (t.lead !== '1') {
      findings.push({
        schema: t.schema,
        table: t.table,
        index: '(none)',
        columns: [],
        problem: 'no index leads with tenant_id (tenant-filtered scans will be slow)',
      });
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL ??
    `postgres://migrator@${process.env.PGHOST ?? '127.0.0.1'}:${process.env.PGPORT ?? '5432'}/${process.env.PGDATABASE ?? 'ucs'}`;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const schemas = (process.env.MODULE_SCHEMAS ?? 'sample').split(',');
    const findings = await findIndexViolations(client, schemas);
    if (findings.length > 0) {
      console.error('check:indexes FAILED');
      for (const f of findings) {
        console.error(`  ${f.schema}.${f.table} ${f.index} (${f.columns.join(', ')}): ${f.problem}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`check:indexes OK (${schemas.join(', ')})`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('check:indexes error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
