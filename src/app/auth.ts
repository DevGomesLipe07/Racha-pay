// Credenciais (03 § Autenticação). Tokens só são comparados pelo hash; nada é logado.
//   Organizador: Authorization: Bearer rpo_…   Convidado: X-Share-Token: rps_…
//   Sistema/estabelecimento: Authorization: Bearer rpk_… (+ X-Actor-Id)   Admin: Bearer <ADMIN_TOKEN> + X-Actor-Id

import { timingSafeEqual } from 'node:crypto';
import { hashToken, tokenKind } from '../infra/crypto/hash.ts';
import type { Pool } from '../infra/db/pool.ts';
import { withoutScope, type TenantDbScope } from '../infra/db/tx.ts';
import type { ActorType } from '../modules/ledger/chain.ts';
import type { PolicyActor } from '../modules/policies/policy-engine.ts';
import { badRequest, notFound, unauthorized } from './errors.ts';

export const PERSONAL_TENANT_ID = '00000000-0000-4000-8000-000000000001';

export type Principal =
  | { kind: 'anonymous' }
  | { kind: 'organizer'; tenantId: string; billId: string }
  | { kind: 'guest'; tenantId: string; billId: string }
  | { kind: 'apiKey'; tenantId: string; tenantKind: 'PERSONAL' | 'BUSINESS'; keyId: string; scopes: string[]; actorType: ActorType; actorId: string }
  | { kind: 'admin'; actorId: string };

const ACTOR_ID = /^[A-Za-z0-9@._:-]{1,120}$/;

function bearer(headers: Record<string, string | undefined>): string | undefined {
  const auth = headers.authorization;
  if (!auth) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) throw unauthorized('Authorization deve ser "Bearer <token>"');
  return m[1];
}

function actorIdHeader(headers: Record<string, string | undefined>, required: boolean): string | undefined {
  const v = headers['x-actor-id'];
  if (v === undefined) {
    if (required) throw badRequest('ACTOR_ID_REQUIRED', 'X-Actor-Id é obrigatório para esta credencial');
    return undefined;
  }
  if (!ACTOR_ID.test(v)) throw badRequest('INVALID_ACTOR_ID', 'X-Actor-Id inválido');
  return v;
}

function equalsSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function resolvePrincipal(pool: Pool, headers: Record<string, string | undefined>, adminToken: string): Promise<Principal> {
  const token = bearer(headers);
  const share = headers['x-share-token'];
  if (token && share) throw badRequest('AMBIGUOUS_CREDENTIALS', 'envie só uma credencial');

  if (share !== undefined) {
    if (tokenKind(share) !== 'share') throw unauthorized();
    const row = await resolveBillToken(pool, share);
    if (!row || row.kind !== 'SHARE') throw unauthorized();
    return { kind: 'guest', tenantId: row.tenant_id, billId: row.bill_id };
  }
  if (!token) return { kind: 'anonymous' };

  const kind = tokenKind(token);
  if (kind === 'organizer') {
    const row = await resolveBillToken(pool, token);
    if (!row || row.kind !== 'ORGANIZER') throw unauthorized();
    return { kind: 'organizer', tenantId: row.tenant_id, billId: row.bill_id };
  }
  if (kind === 'apiKey') {
    const { rows } = await withoutScope(pool, (c) =>
      c.query<{ key_id: string; tenant_id: string; tenant_kind: 'PERSONAL' | 'BUSINESS'; scopes: string[]; actor_type: ActorType }>(
        'SELECT * FROM rp_resolve_api_key($1)',
        [hashToken(token)],
      ),
    );
    const row = rows[0];
    if (!row) throw unauthorized();
    const actorId = actorIdHeader(headers, false) ?? `key:${row.key_id}`;
    return { kind: 'apiKey', tenantId: row.tenant_id, tenantKind: row.tenant_kind, keyId: row.key_id, scopes: row.scopes, actorType: row.actor_type, actorId };
  }
  if (kind === undefined && equalsSecret(token, adminToken)) {
    return { kind: 'admin', actorId: actorIdHeader(headers, true) as string };
  }
  throw unauthorized();
}

async function resolveBillToken(pool: Pool, token: string) {
  const { rows } = await withoutScope(pool, (c) =>
    c.query<{ tenant_id: string; bill_id: string; kind: 'ORGANIZER' | 'SHARE' }>('SELECT * FROM rp_resolve_bill_token($1)', [hashToken(token)]),
  );
  return rows[0];
}

const ORGANIZER_SCOPES = ['bills:read', 'bills:write', 'payments:create', 'payments:write', 'ai:use'];
const GUEST_SCOPES = ['bills:read', 'payments:create', 'ai:use'];

export function policyActor(p: Principal): PolicyActor {
  switch (p.kind) {
    case 'anonymous':
      return { type: 'HUMAN', id: 'anonymous', scopes: ['bills:write'] };
    case 'organizer':
      return { type: 'HUMAN', id: `organizer:${p.billId}`, scopes: ORGANIZER_SCOPES };
    case 'guest':
      return { type: 'HUMAN', id: `guest:${p.billId}`, scopes: GUEST_SCOPES };
    case 'apiKey':
      return { type: p.actorType, id: p.actorId, scopes: p.scopes };
    case 'admin':
      return { type: 'HUMAN', id: `admin:${p.actorId}`, scopes: ['*'] };
  }
}

/** Escopo de banco para acessar uma conta. Token de capacidade só acessa a própria conta (404 para as outras). */
export function billScope(p: Principal, billId: string): TenantDbScope {
  switch (p.kind) {
    case 'organizer':
    case 'guest':
      if (p.billId !== billId) throw notFound('conta');
      return { kind: 'bill', tenantId: p.tenantId, billId };
    case 'apiKey':
      return { kind: 'tenant', tenantId: p.tenantId };
    default:
      throw unauthorized();
  }
}

export function viewerOf(p: Principal): 'organizer' | 'guest' | 'tenant' {
  return p.kind === 'organizer' ? 'organizer' : p.kind === 'guest' ? 'guest' : 'tenant';
}
