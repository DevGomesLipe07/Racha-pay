// Caminho único das rotas que agem sobre uma conta: credencial → escopo (RLS) → Policy Engine →
// transação com audit → serviço → resposta com a conta atualizada.

import { withScope } from '../../infra/db/tx.ts';
import type { PoolClient } from '../../infra/db/pool.ts';
import type { HttpRequest, HttpResponse } from '../../infra/http/router.ts';
import type { PolicyAction } from '../../modules/policies/policy-engine.ts';
import type { ServiceContext } from '../../modules/service-context.ts';
import { billView } from '../../modules/shared-bills/view.ts';
import { billScope, policyActor, resolvePrincipal, viewerOf, type Principal } from '../auth.ts';
import type { AppDeps } from '../deps.ts';
import { auditAllowed, preAuthorize } from '../guard.ts';
import { param } from '../http-helpers.ts';

export type BillAction = (client: PoolClient, ctx: ServiceContext, req: HttpRequest, billId: string, principal: Principal) => Promise<unknown>;

export function routeKit(deps: AppDeps) {
  const { pool, config, clock } = deps;

  const principalOf = (req: HttpRequest) => resolvePrincipal(pool, req.headers, config.ADMIN_TOKEN);

  const ctxOf = (principal: Principal, tenantId: string, req: HttpRequest): ServiceContext => {
    const actor = policyActor(principal);
    return { tenantId, actor: { type: actor.type, id: actor.id }, correlationId: req.correlationId, now: clock.now() };
  };

  /** Executa `fn` sobre a conta `billId` (já autorizada). Usado direto quando o id vem do corpo. */
  const runOnBill = async (
    req: HttpRequest,
    billId: string,
    action: PolicyAction,
    fn: BillAction,
    opts: { respond?: 'bill' | 'result' } = {},
  ): Promise<unknown> => {
    const principal = await principalOf(req);
    const scope = billScope(principal, billId);
    const decision = await preAuthorize(pool, principal, action, { tenantId: scope.tenantId, billId }, req.correlationId);
    return withScope(pool, scope, async (client) => {
      const ctx = ctxOf(principal, scope.tenantId, req);
      await auditAllowed(client, principal, decision, { tenantId: scope.tenantId, billId }, req.correlationId);
      const result = await fn(client, ctx, req, billId, principal);
      if (opts.respond === 'result') return result;
      return { bill: await billView(client, billId, { viewer: viewerOf(principal) }), ...(result && typeof result === 'object' ? result : {}) };
    });
  };

  const onBill =
    (action: PolicyAction, fn: BillAction, opts: { status?: number; respond?: 'bill' | 'result' } = {}) =>
    async (req: HttpRequest): Promise<HttpResponse> => ({
      status: opts.status ?? 200,
      body: await runOnBill(req, param(req, 'id'), action, fn, opts),
    });

  return { principalOf, ctxOf, runOnBill, onBill };
}
