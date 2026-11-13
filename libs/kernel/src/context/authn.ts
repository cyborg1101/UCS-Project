import type { ClientKind, DeviceKind } from './request-context';

/**
 * AuthN contract (K03-T07).
 *
 * Phase 0 deliberately ships only the *interface* plus a deterministic test
 * provider. Real ES256 verification and Google federation land in Phase 1;
 * because the kernel depends on this interface and never on a concrete
 * implementation, Phase 1 swaps the provider without touching module code.
 */
export interface AuthnPrincipal {
  userId: string;
  tenantId: string;
  tenantCode: string;
  roles: readonly string[];
  permissionScope: readonly string[];
  deviceId: string | null;
  deviceKind: DeviceKind | null;
  client: ClientKind;
  /** Present when the token was issued for a specific session/device. */
  sessionId?: string | null;
}

export interface AuthnRequest {
  authorizationHeader: string | null;
  /** Non-sensitive request metadata a provider may need (device header, etc.). */
  headers: Record<string, string | undefined>;
}

export interface AuthnContextProvider {
  readonly name: string;
  /** Resolve a principal, or null when the request is anonymous. */
  authenticate(request: AuthnRequest): Promise<AuthnPrincipal | null>;
}

/** Deterministic provider for tests and the Phase 0 acceptance demo. */
export class StaticAuthnProvider implements AuthnContextProvider {
  readonly name = 'static';

  constructor(
    private readonly principals: Record<string, AuthnPrincipal> = {},
    private readonly fallback: AuthnPrincipal | null = null,
  ) {}

  async authenticate(request: AuthnRequest): Promise<AuthnPrincipal | null> {
    const header = request.authorizationHeader ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
    if (token && this.principals[token]) return this.principals[token] ?? null;
    return this.fallback;
  }
}

export function buildStaticPrincipal(overrides: Partial<AuthnPrincipal> = {}): AuthnPrincipal {
  return {
    userId: '00000000-0000-7000-8000-000000000001',
    tenantId: '00000000-0000-7000-8000-0000000000aa',
    tenantCode: 'AA',
    roles: ['student'],
    permissionScope: [],
    deviceId: null,
    deviceKind: 'web',
    client: 'web',
    ...overrides,
  };
}
