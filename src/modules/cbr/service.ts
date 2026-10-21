// CBR — aprendizado controlado (02 § CBR; prompt mestre § K):
// CASO → DECISÃO HUMANA → RESULTADO → PADRÃO (≥ 3 casos do mesmo tipo com a mesma decisão)
// → PROPOSTA em DRAFT (origem LEARNED, casos como evidência) → REVISÃO humana. Nada ativa sozinho.
// Similaridade relacional por Jaccard sobre os atributos do caso (sem vector DB).

import { conflict, notFound } from '../../app/errors.ts';
import type { PoolClient } from '../../infra/db/pool.ts';
import { proposeKnowledge, type KnowledgeRow } from '../expert/governance.ts';
import type { ServiceContext } from '../service-context.ts';

export const PATTERN_THRESHOLD = 3;

export interface CaseRow {
  id: string;
  bill_id: string;
  kind: string;
  status: 'OPEN' | 'RESOLVED';
  payment_id: string | null;
  participant_id: string | null;
  features: string[];
  evidence: unknown;
  decision: string | null;
  outcome: string | null;
  resolved_by: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

export function caseJson(c: CaseRow) {
  return {
    id: c.id,
    billId: c.bill_id,
    kind: c.kind,
    status: c.status,
    paymentId: c.payment_id,
    participantId: c.participant_id,
    features: c.features,
    evidence: c.evidence,
    decision: c.decision,
    outcome: c.outcome,
    resolvedBy: c.resolved_by,
    createdAt: c.created_at,
    resolvedAt: c.resolved_at,
  };
}

/** Jaccard |A ∩ B| / |A ∪ B| — puro, usado também nos testes para conferir o SQL. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

export async function listCases(client: PoolClient, filters: { kind?: string; status?: string; limit: number }): Promise<CaseRow[]> {
  const { rows } = await client.query<CaseRow>(
    `SELECT * FROM cbr_cases WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT $3`,
    [filters.kind ?? null, filters.status ?? null, filters.limit],
  );
  return rows;
}

export async function similarCases(client: PoolClient, caseId: string, limit: number): Promise<{ case: CaseRow; score: number }[]> {
  const base = await client.query<CaseRow>('SELECT * FROM cbr_cases WHERE id = $1', [caseId]);
  const c = base.rows[0];
  if (!c) throw notFound('caso');
  const { rows } = await client.query<CaseRow & { score: number }>(
    `SELECT x.*,
            (SELECT count(*) FROM (SELECT unnest(x.features) INTERSECT SELECT unnest($2::text[])) i)::float8
          / NULLIF((SELECT count(*) FROM (SELECT unnest(x.features) UNION SELECT unnest($2::text[])) u), 0)::float8 AS score
       FROM cbr_cases x
      WHERE x.id <> $1
      ORDER BY score DESC NULLS LAST, x.status = 'RESOLVED' DESC, x.created_at DESC
      LIMIT $3`,
    [caseId, c.features, limit],
  );
  return rows.filter((r) => (r.score ?? 0) > 0).map((r) => ({ case: r, score: Number(r.score.toFixed(4)) }));
}

export async function resolveCase(client: PoolClient, ctx: ServiceContext, caseId: string, decision: string, outcome: string): Promise<{ case: CaseRow; proposal?: KnowledgeRow }> {
  const { rows } = await client.query<CaseRow>('SELECT * FROM cbr_cases WHERE id = $1 FOR UPDATE', [caseId]);
  const c = rows[0];
  if (!c) throw notFound('caso');
  if (c.status === 'RESOLVED') throw conflict('CASE_RESOLVED', 'caso já resolvido');
  const updated = await client.query<CaseRow>(
    "UPDATE cbr_cases SET status = 'RESOLVED', decision = $2, outcome = $3, resolved_by = $4, resolved_at = $5 WHERE id = $1 RETURNING *",
    [caseId, decision, outcome, ctx.actor.id, ctx.now],
  );
  const proposal = await proposeIfPattern(client, ctx, c.kind, decision);
  return { case: updated.rows[0] as CaseRow, ...(proposal ? { proposal } : {}) };
}

/** Padrão = ≥ 3 casos resolvidos do mesmo tipo com a mesma decisão, sem proposta viva para ele. */
export async function proposeIfPattern(client: PoolClient, ctx: ServiceContext, kind: string, decision: string): Promise<KnowledgeRow | undefined> {
  const support = await client.query<{ id: string }>(
    "SELECT id FROM cbr_cases WHERE kind = $1 AND status = 'RESOLVED' AND decision = $2 ORDER BY resolved_at LIMIT 100",
    [kind, decision],
  );
  if ((support.rowCount ?? 0) < PATTERN_THRESHOLD) return undefined;
  const key = `CBR_PLAYBOOK.${kind}`;
  const alive = await client.query(
    `SELECT 1 FROM knowledge WHERE key = $1 AND tenant_id = $2 AND status IN ('DRAFT', 'REVIEW', 'APPROVED', 'ACTIVE') AND content->>'decision' = $3`,
    [key, ctx.tenantId, decision],
  );
  if ((alive.rowCount ?? 0) > 0) return undefined;
  const ids = support.rows.map((r) => r.id);
  return proposeKnowledge(
    client,
    { actor: { type: 'SYSTEM', id: 'cbr:learning' }, tenantId: ctx.tenantId },
    {
      key,
      scopeType: 'TENANT',
      scopeValue: '',
      content: { caseKind: kind, decision, supportingCaseIds: ids, supportingCases: ids.length },
      rationale: `${ids.length} casos ${kind} resolvidos com a decisão "${decision}"`,
      validFrom: ctx.now,
      origin: 'LEARNED',
    },
  );
}

export async function runProposals(client: PoolClient, ctx: ServiceContext): Promise<KnowledgeRow[]> {
  const groups = await client.query<{ kind: string; decision: string }>(
    `SELECT kind, decision FROM cbr_cases WHERE status = 'RESOLVED' GROUP BY kind, decision HAVING count(*) >= $1`,
    [PATTERN_THRESHOLD],
  );
  const out: KnowledgeRow[] = [];
  for (const g of groups.rows) {
    const p = await proposeIfPattern(client, ctx, g.kind, g.decision);
    if (p) out.push(p);
  }
  return out;
}
