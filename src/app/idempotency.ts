// D12 — Idempotency-Key: escopo (tenant, chave) — e (tenant, conta, chave) em escopo de conta —,
// validade pela Expert Library (IDEMPOTENCY.TTL). Mesma chave + mesmo corpo = mesma resposta;
// mesma chave + corpo diferente = 422 IDEMPOTENCY_MISMATCH. Chamar com a conta já travada.

import { canonicalJson } from '../infra/crypto/canonical-json.ts';
import { sha256Hex } from '../infra/crypto/hash.ts';
import type { PoolClient } from '../infra/db/pool.ts';
import { resolveKnowledge } from '../modules/expert/library.ts';
import { badRequest, conflict, unprocessable } from './errors.ts';

const KEY = /^[A-Za-z0-9_.:-]{8,200}$/;
const ZERO = '00000000-0000-0000-0000-000000000000';

export function idempotencyKeyOf(headers: Record<string, string | undefined>): string {
  const key = headers['idempotency-key'];
  if (!key) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key é obrigatório');
  if (!KEY.test(key)) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key deve ter 8–200 caracteres [A-Za-z0-9_.:-]');
  return key;
}

export function requestHash(method: string, route: string, body: unknown): string {
  return sha256Hex(canonicalJson({ method, route, body: (body ?? null) as never }));
}

export interface IdemScope {
  tenantId: string;
  billId: string | null;
  key: string;
  hash: string;
}

export type IdemBegin = { kind: 'new' } | { kind: 'replay'; status: number; body: unknown };

export async function beginIdempotent(client: PoolClient, scope: IdemScope, now: Date): Promise<IdemBegin> {
  const { rows } = await client.query<{ request_sha256: string; response_status: number | null; response_body: unknown; expires_at: Date }>(
    `SELECT request_sha256, response_status, response_body, expires_at FROM idempotency_keys
      WHERE tenant_id = $1 AND COALESCE(bill_id, $4::uuid) = COALESCE($2::uuid, $4::uuid) AND key = $3 FOR UPDATE`,
    [scope.tenantId, scope.billId, scope.key, ZERO],
  );
  const row = rows[0];
  if (row && row.expires_at <= now) {
    await client.query(
      'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND COALESCE(bill_id, $4::uuid) = COALESCE($2::uuid, $4::uuid) AND key = $3',
      [scope.tenantId, scope.billId, scope.key, ZERO],
    );
  } else if (row) {
    if (row.request_sha256 !== scope.hash) {
      throw unprocessable('IDEMPOTENCY_MISMATCH', 'esta Idempotency-Key já foi usada com outro corpo');
    }
    if (row.response_status === null) throw conflict('IDEMPOTENCY_IN_PROGRESS', 'requisição com esta chave ainda em processamento');
    return { kind: 'replay', status: row.response_status, body: row.response_body };
  }
  const ttl = await resolveKnowledge(client, 'IDEMPOTENCY.TTL', { tenantId: scope.tenantId }, now);
  await client.query(
    'INSERT INTO idempotency_keys (tenant_id, bill_id, key, request_sha256, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [scope.tenantId, scope.billId, scope.key, scope.hash, now, new Date(now.getTime() + ttl.content.hours * 3_600_000)],
  );
  return { kind: 'new' };
}

export async function completeIdempotent(client: PoolClient, scope: IdemScope, status: number, body: unknown): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys SET response_status = $5, response_body = $6::jsonb
      WHERE tenant_id = $1 AND COALESCE(bill_id, $7::uuid) = COALESCE($2::uuid, $7::uuid) AND key = $3 AND request_sha256 = $4`,
    [scope.tenantId, scope.billId, scope.key, scope.hash, status, JSON.stringify(body), ZERO],
  );
}
