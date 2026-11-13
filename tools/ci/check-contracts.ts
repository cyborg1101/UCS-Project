/**
 * check:contracts (K11-T01 / K11-T02 / K11-T03)
 *
 * Three failures this gate must catch, each corresponding to a way a published
 * event contract silently rots:
 *
 *  1. An event the code publishes has no schema file. The registry in
 *     libs/platform/messaging is the runtime truth; db/schemas-contract is what
 *     other teams and the generated clients read. If a new event can ship
 *     without a schema, the published surface is already wrong.
 *  2. A schema changed incompatibly without moving `event_version`. Consumers
 *     built against v1 then break on a message that still claims to be v1.
 *  3. The committed schema file no longer matches what the Zod contract
 *     actually says (someone edited the JSON by hand, or changed the Zod shape
 *     and forgot to regenerate).
 *
 * Baseline for (2) is the version of the file in git HEAD, so the comparison is
 * against what `main` already published.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { contractRegistry } from '../../libs/platform/messaging/src/envelope';
import { contractDocument, type JsonSchema } from '../contracts/zod-to-json-schema';
import { breakingChanges } from '../contracts/breaking-changes';

const ROOT = resolve(__dirname, '../..');
const CONTRACT_DIR = join(ROOT, 'db/schemas-contract');

export interface ContractFinding {
  kind: 'missing' | 'drift' | 'breaking' | 'bad_name';
  contract: string;
  detail: string;
}

function contractFiles(): string[] {
  if (!existsSync(CONTRACT_DIR)) return [];
  return readdirSync(CONTRACT_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

function fileNameFor(type: string, version: number): string {
  return `${type}.v${version}.json`;
}

/** The committed baseline for a path, or null when git has no such file yet. */
function gitShow(path: string): string | null {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Strip the document envelope so two schemas can be compared structurally.
 * `$schema`/`$id`/`title`/`description` are presentation metadata: a change to
 * them is not a change to the event's shape, so it must not register as drift.
 */
function payloadShape(doc: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  delete out['$schema'];
  delete out['$id'];
  delete out['title'];
  delete out['description'];
  return out as JsonSchema;
}

export function findContractViolations(options: { checkBaseline?: boolean } = {}): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const onDisk = new Set(contractFiles());
  const registered = contractRegistry.list();

  // (1) every registered event has a schema file
  for (const entry of registered) {
    const expected = fileNameFor(entry.type, entry.version);
    if (!onDisk.has(expected)) {
      findings.push({
        kind: 'missing',
        contract: `${entry.type}.v${entry.version}`,
        detail: `db/schemas-contract/${expected} is missing; the event is registered but its schema was never published`,
      });
    }
  }

  // and no orphan schema claims to describe an event the code does not publish
  for (const file of onDisk) {
    const stem = file.replace(/\.json$/, '');
    const match = /^(?<type>[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\.v(?<version>\d+)$/.exec(stem);
    if (!match?.groups) {
      findings.push({
        kind: 'bad_name',
        contract: file,
        detail: 'file name must be <module>.<event>.v<N>.json',
      });
      continue;
    }
    const type = match.groups['type']!;
    const version = Number(match.groups['version']);
    if (!contractRegistry.has(type, version)) {
      findings.push({
        kind: 'missing',
        contract: `${type}.v${version}`,
        detail: 'schema file exists but no such event is registered in code (orphan contract)',
      });
    }
  }

  // (2)+(3) drift and breaking changes against the committed baseline
  for (const entry of registered) {
    const expectedName = fileNameFor(entry.type, entry.version);
    const path = `db/schemas-contract/${expectedName}`;
    const abs = join(ROOT, path);
    if (!existsSync(abs)) continue;

    const derived = payloadShape(
      contractDocument(entry.type, entry.version, entry.payload, {
        ...(entry.description === undefined ? {} : { description: entry.description }),
      }),
    );
    const committedRaw = readFileSync(abs, 'utf8');
    let committed: JsonSchema;
    try {
      committed = JSON.parse(committedRaw) as JsonSchema;
    } catch (err) {
      findings.push({
        kind: 'drift',
        contract: `${entry.type}.v${entry.version}`,
        detail: `schema file is not valid JSON: ${(err as Error).message}`,
      });
      continue;
    }

    const committedShape = payloadShape(committed);
    // (3) the file must describe the Zod contract exactly.
    if (JSON.stringify(derived) !== JSON.stringify(committedShape)) {
      findings.push({
        kind: 'drift',
        contract: `${entry.type}.v${entry.version}`,
        detail:
          'schema file does not match the Zod contract in code. ' +
          'Run `npm run contracts:generate` to regenerate it.',
      });
    }

    // (2) a breaking change must not ride an unchanged version number. The
    // baseline is HEAD, i.e. what `main` already published.
    if (options.checkBaseline === false) continue;
    const baselineRaw = gitShow(path);
    if (!baselineRaw) continue; // brand-new contract: nothing to break
    let baseline: JsonSchema;
    try {
      baseline = JSON.parse(baselineRaw) as JsonSchema;
    } catch {
      continue;
    }
    const breaking = breakingChanges(payloadShape(baseline), committedShape);
    if (breaking.length > 0) {
      for (const change of breaking) {
        findings.push({
          kind: 'breaking',
          contract: `${entry.type}.v${entry.version}`,
          detail: `${change.path}: ${change.reason} — a breaking change requires a new event_version`,
        });
      }
    }
  }

  return findings;
}

/** Write (or rewrite) every schema file from the Zod registry (K11-T03). */
export function generateContracts(): string[] {
  const written: string[] = [];
  for (const entry of contractRegistry.list()) {
    const doc = contractDocument(entry.type, entry.version, entry.payload, {
      ...(entry.description === undefined ? {} : { description: entry.description }),
    });
    const name = fileNameFor(entry.type, entry.version);
    const abs = join(CONTRACT_DIR, name);
    const body = `${JSON.stringify(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        ...doc,
      },
      null,
      2,
    )}\n`;
    if (!existsSync(abs) || readFileSync(abs, 'utf8') !== body) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      writeFileSync(abs, body);
      written.push(name);
    }
  }
  return written;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--generate')) {
    const written = generateContracts();
    if (written.length === 0) {
      console.log('check:contracts generate — every schema already up to date');
    } else {
      for (const f of written) console.log(`check:contracts generate — wrote db/schemas-contract/${f}`);
    }
    return;
  }

  const findings = findContractViolations({ checkBaseline: !args.includes('--no-baseline') });
  if (findings.length > 0) {
    console.error('check:contracts FAILED');
    for (const f of findings) console.error(`  [${f.kind}] ${f.contract}: ${f.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check:contracts OK (${contractRegistry.list().length} contracts)`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('check:contracts error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
