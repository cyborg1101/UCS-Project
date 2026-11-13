/**
 * Breaking-change detection for event schemas (K11-T02).
 *
 * Pure functions only: the CLI reads the committed baseline from git and passes
 * both documents in here, so the rules can be unit-tested without a repository.
 *
 * A "breaking" change is one that can make a consumer that was correct against
 * v1 wrong against the new v1 — removing a field it reads, narrowing its type,
 * or making an optional field mandatory. Anything breaking must ship as a new
 * version; the gate refuses the change when the version did not move.
 */
export interface SchemaLike {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaLike>;
  required?: string[];
  items?: SchemaLike;
  enum?: unknown[];
  additionalProperties?: boolean | SchemaLike;
}

export interface BreakingChange {
  path: string;
  reason: string;
}

function compare(prev: SchemaLike, next: SchemaLike, path: string, out: BreakingChange[]): void {
  // A property present before and absent now: consumers reading it break.
  if (prev.type && next.type && prev.type !== next.type) {
    out.push({ path, reason: `type changed from ${prev.type} to ${next.type}` });
    return;
  }

  if (prev.format && prev.format !== next.format) {
    out.push({ path, reason: `format changed from ${prev.format} to ${next.format ?? 'none'}` });
  }

  // Enums: removing an allowed value breaks a consumer that matches on it.
  if (prev.enum) {
    const nextEnum = next.enum ?? [];
    for (const value of prev.enum) {
      if (!nextEnum.includes(value)) {
        out.push({ path, reason: `enum value ${JSON.stringify(value)} was removed` });
      }
    }
  }

  const prevProps = prev.properties ?? {};
  const nextProps = next.properties ?? {};
  const prevRequired = new Set(prev.required ?? []);
  const nextRequired = new Set(next.required ?? []);

  for (const [key, prevChild] of Object.entries(prevProps)) {
    const childPath = path === '$' ? key : `${path}.${key}`;
    const nextChild = nextProps[key];

    if (!nextChild) {
      out.push({ path: childPath, reason: 'property was removed' });
      continue;
    }
    // Optional → required: an existing publisher omitting it now fails.
    if (!prevRequired.has(key) && nextRequired.has(key)) {
      out.push({ path: childPath, reason: 'optional property became required' });
    }
    compare(prevChild, nextChild, childPath, out);
  }

  // Array element shape changed incompatibly.
  if (prev.items && next.items) compare(prev.items, next.items, `${path}[]`, out);
  if (prev.items && !next.items) {
    out.push({ path: `${path}[]`, reason: 'array items schema was removed' });
  }
}

export function breakingChanges(prev: SchemaLike, next: SchemaLike): BreakingChange[] {
  const out: BreakingChange[] = [];
  compare(prev, next, '$', out);
  return out;
}
