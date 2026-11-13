/**
 * Minimal Zod → JSON Schema converter (K11-T01/T02).
 *
 * The runtime source of truth for event shapes is the Zod registry in
 * `libs/platform/messaging/src/envelope.ts`; `db/schemas-contract/*.json` is the
 * published artifact other teams and the generated clients read. Two sources
 * inevitably drift, so the gate re-derives the JSON from Zod and compares.
 *
 * Why a hand-written converter rather than a dependency: the registry only uses
 * a small, explicit subset of Zod (objects, strings, numbers, booleans, arrays,
 * records, enums, literals, nullable/optional/default). Supporting exactly that
 * subset — and throwing on anything else — means a new Zod feature cannot slip
 * into a contract without also teaching this file how to describe it. A silent
 * fallback would produce a schema that understates the real shape.
 */
import { z } from 'zod';

export interface JsonSchema {
  type?: string;
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  const?: unknown;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  default?: unknown;
  description?: string;
}

function intish(schema: JsonSchema): JsonSchema {
  return { type: 'integer', ...schema };
}

function convert(node: z.ZodTypeAny, path: string): JsonSchema {
  // Unwrap modifiers first: `optional`/`default` change `required`, not shape.
  if (node instanceof z.ZodOptional) return convert(node.unwrap() as z.ZodTypeAny, path);
  if (node instanceof z.ZodDefault) {
    const inner = convert(node.removeDefault() as z.ZodTypeAny, path);
    return { ...inner, default: node._def.defaultValue() };
  }
  if (node instanceof z.ZodNullable) {
    const inner = convert(node.unwrap() as z.ZodTypeAny, path);
    // JSON has no "nullable scalar"; express it as a union with null.
    return { anyOf: [inner, { type: 'null' }] };
  }

  if (node instanceof z.ZodObject) {
    const shape = node.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(shape)) {
      properties[key] = convert(child, `${path}.${key}`);
      const optional =
        child instanceof z.ZodOptional ||
        child instanceof z.ZodDefault ||
        (child instanceof z.ZodNullable && child.unwrap() instanceof z.ZodOptional);
      if (!optional) required.push(key);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }

  if (node instanceof z.ZodString) {
    const checks = node._def.checks as Array<{ kind: string; value?: number }>;
    const out: JsonSchema = { type: 'string' };
    for (const c of checks) {
      if (c.kind === 'uuid') out.format = 'uuid';
      if (c.kind === 'min' && typeof c.value === 'number') out.minLength = c.value;
    }
    return out;
  }

  if (node instanceof z.ZodNumber) {
    const checks = node._def.checks as Array<{ kind: string; value?: number }>;
    const out: JsonSchema = {};
    for (const c of checks) {
      if (c.kind === 'int') out.type = 'integer';
      if (c.kind === 'min' && typeof c.value === 'number') out.minimum = c.value;
      if (c.kind === 'max' && typeof c.value === 'number') out.maximum = c.value;
    }
    return out.type === 'integer' ? intish(out) : { ...out, type: 'number' };
  }

  if (node instanceof z.ZodBoolean) return { type: 'boolean' };

  if (node instanceof z.ZodArray) {
    return { type: 'array', items: convert(node.element as z.ZodTypeAny, `${path}[]`) };
  }

  if (node instanceof z.ZodRecord) {
    return { type: 'object', additionalProperties: true };
  }

  if (node instanceof z.ZodEnum) {
    return { type: 'string', enum: [...(node._def.values as string[])] };
  }

  if (node instanceof z.ZodLiteral) {
    const value = node._def.value;
    return { const: value, type: typeof value === 'number' ? 'number' : typeof value };
  }

  throw new Error(
    `zodToJsonSchema: unsupported Zod node at ${path} (${node.constructor.name}). ` +
      `Extend tools/contracts/zod-to-json-schema.ts so the published schema describes the real shape.`,
  );
}

export function zodToJsonSchema(node: z.ZodTypeAny): JsonSchema {
  return convert(node, '$');
}

/** The published document for one contract (`<type>.v<N>.json`). */
export function contractDocument(
  type: string,
  version: number,
  payload: z.ZodTypeAny,
  meta: { description?: string } = {},
): JsonSchema & { $id: string; title: string; description?: string } {
  return {
    $id: `${type}.v${version}`,
    title: `${type} v${version}`,
    ...(meta.description === undefined ? {} : { description: meta.description }),
    ...zodToJsonSchema(payload),
  };
}
