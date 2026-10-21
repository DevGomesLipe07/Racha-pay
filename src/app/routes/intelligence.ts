// Expert Library (governança) e CBR (03 § Rotas). Tenant: chave de API. Conhecimento compartilhado:
// administrador da plataforma (ADMIN_TOKEN + X-Actor-Id).

import { z } from 'zod';
import { withScope, type DbScope } from '../../infra/db/tx.ts';
import type { PoolClient } from '../../infra/db/pool.ts';
import type { HttpRequest, Router } from '../../infra/http/router.ts';
import { caseJson, listCases, resolveCase, runProposals, similarCases } from '../../modules/cbr/service.ts';
import { KNOWLEDGE_STATUSES, knowledgeJson, proposeKnowledge, transitionKnowledge, type GovernanceActor } from '../../modules/expert/governance.ts';
import { CONTENT_SCHEMAS, provenance, resolveKnowledge, SCOPE_ORDER, type KnowledgeKey } from '../../modules/expert/library.ts';
import type { PolicyAction } from '../../modules/policies/policy-engine.ts';
import type { ServiceContext } from '../../modules/service-context.ts';
import type { Principal } from '../auth.ts';
import type { AppDeps } from '../deps.ts';
import { badRequest, forbidden, unprocessable } from '../errors.ts';
import { auditAllowed, preAuthorize } from '../guard.ts';
import { param, parseBody, uuid } from '../http-helpers.ts';
import { routeKit } from './common.ts';

const ZERO_TENANT = '00000000-0000-0000-0000-000000000000';

const proposeSchema = z
  .object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)+$/),
    scopeType: z.enum(SCOPE_ORDER),
    scopeValue: z.string().max(120).default(''),
    content: z.unknown(),
    rationale: z.string().trim().min(3).max(1000),
    validFrom: z.iso.datetime().optional(),
    validTo: z.iso.datetime().optional(),
  })
  .strict();

export function registerIntelligenceRoutes(router: Router, deps: AppDeps): void {
  const { pool, clock } = deps;
  const { principalOf, ctxOf } = routeKit(deps);

  /** Escopo de governança: chave de API → tenant; admin → plataforma. */
  const governed = async <T>(
    req: HttpRequest,
    action: PolicyAction,
    fn: (client: PoolClient, ctx: ServiceContext, who: GovernanceActor, principal: Principal) => Promise<T>,
    opts: { tenantOnly?: boolean } = {},
  ) => {
    const principal = await principalOf(req);
    if (principal.kind !== 'apiKey' && principal.kind !== 'admin') throw forbidden('use uma chave de API do tenant ou a credencial de administrador');
    let tenantId: string | null = principal.kind === 'apiKey' ? principal.tenantId : null;
    if (opts.tenantOnly && principal.kind === 'admin') {
      // Casos são do tenant; o administrador da plataforma atua num tenant informado (ex.: o Pessoal, sem chave de API).
      const t = req.query.get('tenantId');
      if (!t || !uuid.safeParse(t).success) throw badRequest('TENANT_REQUIRED', 'administrador: informe tenantId');
      tenantId = t;
    }
    const decision = await preAuthorize(pool, principal, action, { tenantId, billId: null }, req.correlationId);
    const scope: DbScope = tenantId ? { kind: 'tenant', tenantId } : { kind: 'platform' };
    return withScope(pool, scope, async (client) => {
      await auditAllowed(client, principal, decision, { tenantId, billId: null }, req.correlationId);
      const ctx = ctxOf(principal, tenantId ?? ZERO_TENANT, req);
      return fn(client, ctx, { actor: ctx.actor, tenantId }, principal);
    });
  };

  router.get('/v1/knowledge', async (req) => {
    const key = req.query.get('key');
    const status = req.query.get('status');
    if (status && !(KNOWLEDGE_STATUSES as readonly string[]).includes(status)) throw unprocessable('VALIDATION_ERROR', 'status inválido');
    const body = await governed(req, 'knowledge.read', async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM knowledge WHERE ($1::text IS NULL OR key = $1) AND ($2::text IS NULL OR status = $2)
          ORDER BY key, array_position($3::text[], scope_type), version DESC LIMIT 500`,
        [key, status, SCOPE_ORDER as unknown as string[]],
      );
      return { knowledge: rows.map(knowledgeJson) };
    });
    return { status: 200, body };
  });

  router.get('/v1/knowledge/resolve', async (req) => {
    const key = req.query.get('key') ?? '';
    if (!(key in CONTENT_SCHEMAS)) throw unprocessable('UNKNOWN_KEY', 'chave operacional desconhecida');
    const body = await governed(req, 'knowledge.read', async (client, ctx) => {
      const resolved = await resolveKnowledge(
        client,
        key as KnowledgeKey,
        {
          tenantId: ctx.tenantId,
          ...(req.query.get('segment') ? { segment: req.query.get('segment') as string } : {}),
          ...(req.query.get('erp') ? { erp: req.query.get('erp') as string } : {}),
          ...(req.query.get('psp') ? { psp: req.query.get('psp') as string } : {}),
          ...(req.query.get('establishmentId') ? { establishmentId: req.query.get('establishmentId') as string } : {}),
        },
        clock.now(),
      );
      return { resolved: { ...provenance(resolved), content: resolved.content } };
    });
    return { status: 200, body };
  });

  router.post('/v1/knowledge', async (req) => {
    const body = await governed(req, 'knowledge.propose', async (client, ctx, who) => {
      const input = parseBody(proposeSchema, req);
      const k = await proposeKnowledge(client, who, {
        key: input.key,
        scopeType: input.scopeType,
        scopeValue: input.scopeValue,
        content: input.content,
        rationale: input.rationale,
        validFrom: input.validFrom ? new Date(input.validFrom) : ctx.now,
        ...(input.validTo ? { validTo: new Date(input.validTo) } : {}),
        origin: 'HUMAN',
      });
      return { knowledge: knowledgeJson(k) };
    });
    return { status: 201, body };
  });

  router.post('/v1/knowledge/:id/transition', async (req) => {
    const id = param(req, 'id');
    // A ação depende do destino; sem credencial válida a resposta é 401 antes de qualquer validação de corpo.
    await principalOf(req);
    const { to } = parseBody(z.object({ to: z.enum(['REVIEW', 'DRAFT', 'APPROVED', 'ACTIVE', 'REVOKED']) }).strict(), req);
    // Aprovar/ativar: humano + escopo de aprovação (Policy Engine). Revisar/revogar: escrita.
    const action: PolicyAction = to === 'APPROVED' ? 'knowledge.approve' : to === 'ACTIVE' ? 'knowledge.activate' : 'knowledge.propose';
    const body = await governed(req, action, async (client, ctx, who) => ({ knowledge: knowledgeJson(await transitionKnowledge(client, who, id, to, ctx.now)) }));
    return { status: 200, body };
  });

  router.get('/v1/cbr/cases', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.get('limit') ?? 50) || 50, 1), 200);
    const kind = req.query.get('kind');
    const status = req.query.get('status');
    const body = await governed(
      req,
      'cbr.read',
      async (client) => ({ cases: (await listCases(client, { ...(kind ? { kind } : {}), ...(status ? { status } : {}), limit })).map(caseJson) }),
      { tenantOnly: true },
    );
    return { status: 200, body };
  });

  router.get('/v1/cbr/cases/:id/similar', async (req) => {
    const id = param(req, 'id');
    const body = await governed(
      req,
      'cbr.read',
      async (client) => ({ similar: (await similarCases(client, id, 5)).map((s) => ({ score: s.score, case: caseJson(s.case) })) }),
      { tenantOnly: true },
    );
    return { status: 200, body };
  });

  router.post('/v1/cbr/cases/:id/resolve', async (req) => {
    const id = param(req, 'id');
    const input = parseBody(z.object({ decision: z.string().trim().min(1).max(120), outcome: z.string().trim().min(1).max(500) }).strict(), req);
    const body = await governed(
      req,
      'cbr.resolve',
      async (client, ctx) => {
        const r = await resolveCase(client, ctx, id, input.decision, input.outcome);
        return { case: caseJson(r.case), ...(r.proposal ? { proposal: knowledgeJson(r.proposal) } : {}) };
      },
      { tenantOnly: true },
    );
    return { status: 200, body };
  });

  router.post('/v1/cbr/proposals', async (req) => {
    const body = await governed(req, 'cbr.resolve', async (client, ctx) => ({ proposals: (await runProposals(client, ctx)).map(knowledgeJson) }), { tenantOnly: true });
    return { status: 200, body };
  });
}
