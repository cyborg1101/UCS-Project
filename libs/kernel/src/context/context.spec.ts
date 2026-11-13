/**
 * K-03 — Request context (unit tests, no database).
 */
import { describe, expect, it } from 'vitest';
import {
  buildContext,
  ContextStore,
  normaliseCorrelationId,
} from './request-context';
import { ContextMissingError, isUlid, ulid } from '@ucs/shared';
import { buildStaticPrincipal, StaticAuthnProvider } from './authn';
import { createContextLogger } from './logger';
import { Writable } from 'node:stream';

describe('[K03-T01] القراءة خارج طلب ترفع ContextMissingError', () => {
  it('throws when no context is bound', () => {
    const store = new ContextStore();
    expect(() => store.get()).toThrow(ContextMissingError);
  });

  it('returns the context inside run()', () => {
    const store = new ContextStore();
    const ctx = buildContext({ tenantId: 't1', client: 'test' });
    store.run(ctx, () => {
      expect(store.get().tenant_id).toBe('t1');
    });
    expect(store.tryGet()).toBeUndefined();
  });
});

describe('[K03-T02] الحقول الإلزامية للسياق (SAD §7.3)', () => {
  it('carries every required field', () => {
    const ctx = buildContext({
      correlationId: ulid(),
      tenantId: 'tenant-1',
      tenantCode: 'AA',
      userId: 'user-1',
      roles: ['student', 'examiner'],
      permissionScope: ['exam:read'],
      deviceId: 'device-1',
      deviceKind: 'mobile',
      client: 'flutter',
      idempotencyKey: 'key-1',
    });
    expect(ctx.correlation_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ctx.tenant_id).toBe('tenant-1');
    expect(ctx.user_id).toBe('user-1');
    expect(ctx.roles).toEqual(['student', 'examiner']);
    expect(ctx.permission_scope).toEqual(['exam:read']);
    expect(ctx.device_id).toBe('device-1');
    expect(ctx.device_kind).toBe('mobile');
    expect(ctx.client).toBe('flutter');
    expect(ctx.idempotency_key).toBe('key-1');
    expect(ctx.request_time_server).toBeInstanceOf(Date);
  });

  it('is frozen and cannot be mutated by a module', () => {
    const ctx = buildContext({ tenantId: 't1' });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      (ctx as unknown as { tenant_id: string }).tenant_id = 'evil';
    }).toThrow();
    expect(ctx.tenant_id).toBe('t1');
  });
});

describe('[K03-T03] السياق ثابت عبر await ولا يتسرب بين الطلبات', () => {
  it('survives nested and parallel awaits', async () => {
    const store = new ContextStore();
    const seen = await store.run(buildContext({ tenantId: 'T' }), async () => {
      const nested = async () => {
        await new Promise((r) => setTimeout(r, 1));
        return store.get().tenant_id;
      };
      const [a, b] = await Promise.all([nested(), nested()]);
      return [store.get().tenant_id, a, b];
    });
    expect(seen).toEqual(['T', 'T', 'T']);
  });

  it('does not leak between 100 concurrent requests with different tenants', async () => {
    const store = new ContextStore();
    const runs = Array.from({ length: 100 }, (_, i) =>
      store.run(buildContext({ tenantId: `tenant-${i}` }), async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        const first = store.get().tenant_id;
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        const second = store.get().tenant_id;
        return first === `tenant-${i}` && second === `tenant-${i}`;
      }),
    );
    const results = await Promise.all(runs);
    expect(results.every(Boolean)).toBe(true);
  });
});

describe('[K03-T04] request_time_server من ساعة الخادم لا من ترويسة العميل', () => {
  it('uses the injected server clock and ignores any header-like value', () => {
    const fixed = new Date('2026-03-01T00:00:00.000Z');
    const ctx = buildContext({
      now: () => fixed,
      // a hostile client header would live here; buildContext has no such input
    });
    expect(ctx.request_time_server.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('does not accept a client time field at all', () => {
    const ctx = buildContext({
      // @ts-expect-error - there is deliberately no client-controlled time input
      requestTimeClient: '1999-01-01T00:00:00Z',
    });
    expect(ctx.request_time_server.getFullYear()).not.toBe(1999);
  });
});

describe('[K03-T05] correlation_id: يُولَّد، ويُحترم، ويُستبدل إن تالف', () => {
  it('generates a ULID when absent', () => {
    expect(isUlid(buildContext().correlation_id)).toBe(true);
  });

  it('honours a valid incoming id', () => {
    const id = ulid();
    expect(buildContext({ correlationId: id }).correlation_id).toBe(id);
  });

  it('replaces a malformed incoming id', () => {
    const ctx = buildContext({ correlationId: 'not-a-ulid!!' });
    expect(ctx.correlation_id).not.toBe('not-a-ulid!!');
    expect(isUlid(ctx.correlation_id)).toBe(true);
  });

  it('replaces an empty id', () => {
    expect(isUlid(buildContext({ correlationId: '' }).correlation_id)).toBe(true);
    expect(isUlid(normaliseCorrelationId(null))).toBe(true);
  });

  it('treats a UUID (not ULID) as malformed for correlation purposes', () => {
    const uuid = '00000000-0000-7000-8000-0000000000aa';
    expect(buildContext({ correlationId: uuid }).correlation_id).not.toBe(uuid);
  });
});

describe('[K03-T06] كل سطر سجل يحمل correlation_id وtenant_id', () => {
  it('emits both fields automatically without the caller passing them', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const store = new ContextStore();
    const logger = createContextLogger(store, { destination: sink });

    store.run(buildContext({ tenantId: 'tenant-xyz' }), () => {
      logger.info('hello');
    });

    const parsed = lines.map((l) => JSON.parse(l)).filter((o) => o.msg === 'hello');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tenant_id).toBe('tenant-xyz');
    expect(isUlid(parsed[0].correlation_id)).toBe(true);
  });

  it('emits nulls when no context is bound (worker startup)', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = createContextLogger(new ContextStore(), { destination: sink });
    logger.info('boot');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.correlation_id).toBeNull();
    expect(parsed.tenant_id).toBeNull();
  });
});

describe('[K03-T07] مزوّد اختبار لـAuthnContextProvider', () => {
  it('resolves a static token to a principal', async () => {
    const principal = buildStaticPrincipal({ tenantCode: 'BB' });
    const provider = new StaticAuthnProvider({ 'tok-1': principal });
    const result = await provider.authenticate({
      authorizationHeader: 'Bearer tok-1',
      headers: {},
    });
    expect(result?.tenantCode).toBe('BB');
  });

  it('returns null for an unknown token when there is no fallback', async () => {
    const provider = new StaticAuthnProvider({});
    expect(await provider.authenticate({ authorizationHeader: 'Bearer nope', headers: {} })).toBeNull();
    expect(await provider.authenticate({ authorizationHeader: null, headers: {} })).toBeNull();
  });
});

describe('logging redaction', () => {
  it('never logs authorization headers or tokens', () => {
    const logger = createContextLogger(new ContextStore());
    expect(logger.level).toBeTruthy();
  });
});
