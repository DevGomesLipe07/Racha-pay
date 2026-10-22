// Estabelecimentos e ERP Gateway (03 § Contrato canônico). Só credencial de tenant (chave de API).

import { z } from 'zod';
import { withScope } from '../../infra/db/tx.ts';
import type { HttpRequest, Router } from '../../infra/http/router.ts';
import { ADAPTERS, BLOCKED_ADAPTERS, ErpAdapterError } from '../../modules/integrations/erp/adapter.ts';
import { ackFromErp, syncFromErp } from '../../modules/integrations/erp/gateway.ts';
import { decide, type PolicyAction } from '../../modules/policies/policy-engine.ts';
import { billView } from '../../modules/shared-bills/view.ts';
import { policyActor, type Principal } from '../auth.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, forbidden, notFound, unprocessable } from '../errors.ts';
import { auditAllowed, preAuthorize } from '../guard.ts';
import { parseBody } from '../http-helpers.ts';
import { routeKit } from './common.ts';
import type { PoolClient } from '../../infra/db/pool.ts';
import type { ServiceContext } from '../../modules/service-context.ts';

export const establishmentSchema = z
  .object({ externalId: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/), name: z.string().trim().min(1).max(120) })
  .strict();

export function registerErpRoutes(router: Router, deps: AppDeps): void {
  const { pool, config } = deps;
  const { principalOf, ctxOf } = routeKit(deps);

  const onTenant = async <T>(req: HttpRequest, action: PolicyAction, fn: (client: PoolClient, ctx: ServiceContext, principal: Principal & { kind: 'apiKey' }) => Promise<T>) => {
    const principal = await principalOf(req);
    if (principal.kind !== 'apiKey') throw forbidden('use uma chave de API do estabelecimento');
    const decision = await preAuthorize(pool, principal, action, { tenantId: principal.tenantId, billId: null }, req.correlationId);
    return withScope(pool, { kind: 'tenant', tenantId: principal.tenantId }, async (client) => {
      await auditAllowed(client, principal, decision, { tenantId: principal.tenantId, billId: null }, req.correlationId);
      return fn(client, ctxOf(principal, principal.tenantId, req), principal);
    });
  };

  const adapterFor = (req: HttpRequest) => {
    const provider = req.params.provider ?? '';
    const blocked = BLOCKED_ADAPTERS[provider];
    if (blocked) throw new AppError(501, 'ERP_ADAPTER_BLOCKED', blocked);
    const adapter = ADAPTERS[provider];
    if (!adapter) throw notFound('ERP');
    return adapter;
  };

  const canonical = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ErpAdapterError) throw unprocessable('VALIDATION_ERROR', e.message, { issues: e.issues });
      throw e;
    }
  };

  router.post('/v1/establishments', async (req) => {
    const input = parseBody(establishmentSchema, req);
    const body = await onTenant(req, 'establishment.manage', async (client, ctx) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO establishments (tenant_id, external_id, name) VALUES ($1, $2, $3) RETURNING id',
        [ctx.tenantId, input.externalId, input.name],
      );
      return { establishment: { id: (rows[0] as { id: string }).id, externalId: input.externalId, name: input.name } };
    });
    return { status: 201, body };
  });

  router.get('/v1/establishments', async (req) => {
    const body = await onTenant(req, 'bill.read', async (client) => {
      const { rows } = await client.query('SELECT id, external_id, name, created_at FROM establishments ORDER BY name');
      return { establishments: rows.map((r) => ({ id: r.id, externalId: r.external_id, name: r.name, createdAt: r.created_at })) };
    });
    return { status: 200, body };
  });

  router.post('/v1/integrations/erp/:provider/sync', async (req) => {
    const adapter = adapterFor(req);
    const input = canonical(() => adapter.toCanonicalSync(req.body));
    const { status, body } = await onTenant(req, 'erp.sync', async (client, ctx, principal) => {
      // Complemento confirma dinheiro: exige também a permissão de complementar a divisão.
      const allowComplement = decide('split.complement', policyActor(principal)).allowed;
      const result = await syncFromErp(client, ctx, adapter.provider, input, { allowComplement });
      if (result.status === 'COMPLEMENTED') {
        await auditAllowed(client, principal, decide('split.complement', policyActor(principal)), { tenantId: ctx.tenantId, billId: result.billId }, req.correlationId);
      }
      const bill = await billView(client, result.billId, { viewer: 'tenant' });
      const shareUrl = result.shareToken ? `${config.PUBLIC_BASE_URL}/#/s/${result.billId}/${result.shareToken}` : undefined;
      if (result.status === 'DIVERGENCE') {
        return {
          status: 409,
          body: {
            error: {
              code: 'ERP_DIVERGENCE',
              message: 'o ERP alterou algo que já estava na divisão confirmada',
              details: { divergence: result.divergence, caseId: result.caseId, billId: result.billId },
              correlationId: req.correlationId,
            },
          },
        };
      }
      return {
        status: result.status === 'CREATED' ? 201 : 200,
        body: { result: result.status, billId: result.billId, ...(result.splitVersion ? { splitVersion: result.splitVersion } : {}), ...(shareUrl ? { shareUrl } : {}), bill },
      };
    });
    return { status, body };
  });

  router.post('/v1/integrations/erp/:provider/ack', async (req) => {
    const adapter = adapterFor(req);
    const input = canonical(() => adapter.toCanonicalAck(req.body));
    const body = await onTenant(req, 'erp.ack', async (client, ctx) => ({ acknowledged: true, ...(await ackFromErp(client, ctx, adapter.provider, input)) }));
    return { status: 200, body };
  });
}
