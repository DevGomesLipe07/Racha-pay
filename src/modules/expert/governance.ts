// Governança da Expert Library (02 § Expert Library; prompt mestre § J).
// Mudança de regra = nova versão: DRAFT → REVIEW → APPROVED → ACTIVE (a anterior vira SUPERSEDED).
// Aprovar/ativar exige humano (Policy Engine); regra crítica exige aprovador ≠ autor (também no banco).
// Escopos compartilhados (GLOBAL…PSP) só pelo administrador da plataforma; TENANT/ESTABLISHMENT pelo tenant.

import { conflict, forbidden, notFound, unprocessable } from '../../app/errors.ts';
import type { PoolClient } from '../../infra/db/pool.ts';
import type { LedgerActor } from '../ledger/chain.ts';
import { BILL_KINDS } from '../shared-bills/repo.ts';
import { isCriticalKey, schemaFor, SCOPE_ORDER, type KnowledgeScope } from './library.ts';

export const KNOWLEDGE_STATUSES = ['DRAFT', 'REVIEW', 'APPROVED', 'ACTIVE', 'SUPERSEDED', 'REVOKED', 'EXPIRED'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];
export const SHARED_SCOPES: readonly KnowledgeScope[] = ['GLOBAL', 'COUNTRY', 'SEGMENT', 'ERP', 'PSP'];

export interface Proposal {
  key: string;
  scopeType: KnowledgeScope;
  scopeValue: string;
  content: unknown;
  rationale: string;
  validFrom: Date;
  validTo?: Date;
  origin: 'HUMAN' | 'LEARNED';
}

export interface GovernanceActor {
  actor: LedgerActor;
  /** null = administrador da plataforma (escopos compartilhados). */
  tenantId: string | null;
}

export interface KnowledgeRow {
  id: string;
  key: string;
  scope_type: KnowledgeScope;
  scope_value: string;
  tenant_id: string | null;
  version: number;
  status: KnowledgeStatus;
  critical: boolean;
  origin: string;
  content: unknown;
  rationale: string;
  author: string;
  approved_by: string | null;
  valid_from: Date;
  valid_to: Date | null;
  created_at: Date;
  activated_at: Date | null;
}

async function validateScope(client: PoolClient, who: GovernanceActor, scopeType: KnowledgeScope, scopeValue: string): Promise<void> {
  if (!SCOPE_ORDER.includes(scopeType)) throw unprocessable('INVALID_SCOPE', 'escopo inválido');
  const shared = SHARED_SCOPES.includes(scopeType);
  if (shared && who.tenantId !== null) throw forbidden('escopos compartilhados só pelo administrador da plataforma');
  if (!shared && who.tenantId === null) throw unprocessable('INVALID_SCOPE', 'escopo de tenant exige uma credencial de tenant');
  const ok =
    (scopeType === 'GLOBAL' && scopeValue === '') ||
    (scopeType === 'COUNTRY' && /^[A-Z]{2}$/.test(scopeValue)) ||
    (scopeType === 'SEGMENT' && (BILL_KINDS as readonly string[]).includes(scopeValue)) ||
    ((scopeType === 'ERP' || scopeType === 'PSP') && /^[a-z0-9-]{1,40}$/.test(scopeValue)) ||
    (scopeType === 'TENANT' && scopeValue === '') ||
    scopeType === 'ESTABLISHMENT';
  if (!ok) throw unprocessable('INVALID_SCOPE', `valor de escopo inválido para ${scopeType}`);
  if (scopeType === 'ESTABLISHMENT') {
    const est = await client.query('SELECT 1 FROM establishments WHERE id::text = $1', [scopeValue]);
    if (est.rowCount === 0) throw unprocessable('INVALID_SCOPE', 'estabelecimento inexistente');
  }
}

export async function proposeKnowledge(client: PoolClient, who: GovernanceActor, p: Proposal): Promise<KnowledgeRow> {
  const schema = schemaFor(p.key);
  if (!schema) throw unprocessable('UNKNOWN_KEY', `chave de conhecimento sem schema: ${p.key}`);
  const parsed = schema.safeParse(p.content);
  if (!parsed.success) {
    throw unprocessable('INVALID_CONTENT', 'conteúdo não passa no schema da chave', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  await validateScope(client, who, p.scopeType, p.scopeValue);
  if (p.validTo && p.validTo <= p.validFrom) throw unprocessable('INVALID_VALIDITY', 'validTo deve ser depois de validFrom');
  const { rows } = await client.query<KnowledgeRow>(
    `INSERT INTO knowledge (key, scope_type, scope_value, tenant_id, version, status, critical, origin, content, rationale, author, valid_from, valid_to)
     VALUES ($1, $2, $3, $4,
             (SELECT COALESCE(MAX(version), 0) + 1 FROM knowledge
               WHERE key = $1 AND scope_type = $2 AND scope_value = $3 AND tenant_id IS NOT DISTINCT FROM $4),
             'DRAFT', $5, $6, $7::jsonb, $8, $9, $10, $11)
     RETURNING *`,
    [p.key, p.scopeType, p.scopeValue, who.tenantId, isCriticalKey(p.key), p.origin, JSON.stringify(parsed.data), p.rationale, who.actor.id, p.validFrom, p.validTo ?? null],
  );
  return rows[0] as KnowledgeRow;
}

const NEXT: Record<KnowledgeStatus, KnowledgeStatus[]> = {
  DRAFT: ['REVIEW', 'REVOKED'],
  REVIEW: ['DRAFT', 'APPROVED', 'REVOKED'],
  APPROVED: ['ACTIVE', 'REVOKED'],
  ACTIVE: ['REVOKED'],
  SUPERSEDED: [],
  REVOKED: [],
  EXPIRED: [],
};

export async function transitionKnowledge(client: PoolClient, who: GovernanceActor, id: string, to: KnowledgeStatus, now: Date): Promise<KnowledgeRow> {
  // Leitura sem trava primeiro: FOR UPDATE obedece às políticas de UPDATE e esconderia a linha de outro nível.
  const visible = await client.query<{ tenant_id: string | null }>('SELECT tenant_id FROM knowledge WHERE id = $1', [id]);
  if (!visible.rows[0]) throw notFound('conhecimento');
  if ((visible.rows[0].tenant_id === null) !== (who.tenantId === null)) throw forbidden('este conhecimento pertence a outro nível de governança');
  const { rows } = await client.query<KnowledgeRow>('SELECT * FROM knowledge WHERE id = $1 FOR UPDATE', [id]);
  const k = rows[0];
  if (!k) throw notFound('conhecimento');
  if (!NEXT[k.status].includes(to)) throw conflict('INVALID_TRANSITION', `não é possível ir de ${k.status} para ${to}`, { allowed: NEXT[k.status] });
  if (to === 'APPROVED' && k.critical && k.author === who.actor.id) {
    throw forbidden('regra crítica exige aprovador diferente do autor (quatro olhos)');
  }
  if (to === 'ACTIVE') {
    // A versão ativa anterior da mesma chave e escopo sai de cena (fica no histórico).
    await client.query(
      `UPDATE knowledge SET status = 'SUPERSEDED'
        WHERE status = 'ACTIVE' AND key = $1 AND scope_type = $2 AND scope_value = $3 AND tenant_id IS NOT DISTINCT FROM $4 AND id <> $5`,
      [k.key, k.scope_type, k.scope_value, k.tenant_id, k.id],
    );
  }
  const { rows: updated } = await client.query<KnowledgeRow>(
    `UPDATE knowledge SET status = $2,
            approved_by = CASE WHEN $2 = 'APPROVED' THEN $3 ELSE approved_by END,
            activated_at = CASE WHEN $2 = 'ACTIVE' THEN $4 ELSE activated_at END
      WHERE id = $1 RETURNING *`,
    [id, to, who.actor.id, now],
  );
  return updated[0] as KnowledgeRow;
}

export function knowledgeJson(k: KnowledgeRow) {
  return {
    id: k.id,
    key: k.key,
    scope: k.scope_value ? `${k.scope_type}:${k.scope_value}` : k.scope_type,
    scopeType: k.scope_type,
    scopeValue: k.scope_value,
    shared: k.tenant_id === null,
    version: k.version,
    status: k.status,
    critical: k.critical,
    origin: k.origin,
    content: k.content,
    rationale: k.rationale,
    author: k.author,
    approvedBy: k.approved_by,
    validFrom: k.valid_from,
    validTo: k.valid_to,
    activatedAt: k.activated_at,
  };
}
