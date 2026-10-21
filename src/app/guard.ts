// Guarda de política: decide pela Policy Engine e audita. Negada → audit numa transação própria
// (sobrevive ao rollback) e 403. Crítica permitida → audit na mesma transação da ação (atômico).

import type { Pool, PoolClient } from '../infra/db/pool.ts';
import { withoutScope, withScope } from '../infra/db/tx.ts';
import { decide, type PolicyAction, type PolicyDecision } from '../modules/policies/policy-engine.ts';
import { policyActor, type Principal } from './auth.ts';
import { forbidden } from './errors.ts';

export interface AuditTarget {
  tenantId: string | null;
  billId: string | null;
}

async function insertAudit(client: PoolClient, principal: Principal, d: PolicyDecision, target: AuditTarget, correlationId: string) {
  const actor = policyActor(principal);
  await client.query(
    `INSERT INTO audit_log (tenant_id, bill_id, actor_type, actor_id, action, allowed, reason, policy_version, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [target.tenantId, target.billId, principal.kind === 'anonymous' ? 'ANONYMOUS' : actor.type, actor.id, d.action, d.allowed, d.reason, d.policyVersion, correlationId],
  );
}

/** Checa antes de abrir a transação da ação. Lança 403 (já auditado) se negado. */
export async function preAuthorize(pool: Pool, principal: Principal, action: PolicyAction, target: AuditTarget, correlationId: string): Promise<PolicyDecision> {
  const d = decide(action, policyActor(principal));
  if (!d.allowed) {
    const run = (c: PoolClient) => insertAudit(c, principal, d, target, correlationId);
    if (target.tenantId) {
      await withScope(pool, target.billId ? { kind: 'bill', tenantId: target.tenantId, billId: target.billId } : { kind: 'tenant', tenantId: target.tenantId }, run);
    } else {
      await withoutScope(pool, run);
    }
    throw forbidden(d.reason, { action });
  }
  return d;
}

/** Dentro da transação da ação: grava o audit das decisões críticas permitidas. */
export async function auditAllowed(client: PoolClient, principal: Principal, d: PolicyDecision, target: AuditTarget, correlationId: string): Promise<void> {
  if (d.audit) await insertAudit(client, principal, d, target, correlationId);
}
