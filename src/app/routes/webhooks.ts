// Gestão de webhooks de saída (03 § Webhooks): só credencial de tenant (chave de API com webhooks:write).

import { z } from 'zod';
import { parseEncryptionKey } from '../../infra/crypto/aead.ts';
import { withScope } from '../../infra/db/tx.ts';
import type { HttpRequest, Router } from '../../infra/http/router.ts';
import { createEndpoint } from '../../modules/integrations/webhooks/delivery.ts';
import { WEBHOOK_EVENT_TYPES } from '../../modules/integrations/webhooks/outbox.ts';
import { DestinationError, policyFor } from '../../modules/integrations/webhooks/ssrf.ts';
import type { PolicyAction } from '../../modules/policies/policy-engine.ts';
import type { Principal } from '../auth.ts';
import type { AppDeps } from '../deps.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { auditAllowed, preAuthorize } from '../guard.ts';
import { param, parseBody } from '../http-helpers.ts';
import { routeKit } from './common.ts';

const createSchema = z
  .object({
    url: z.string().min(8).max(2000),
    events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).max(WEBHOOK_EVENT_TYPES.length).default([]),
    description: z.string().trim().max(200).optional(),
  })
  .strict();

export function registerWebhookRoutes(router: Router, deps: AppDeps): void {
  const { pool, config } = deps;
  const { principalOf } = routeKit(deps);
  const key = parseEncryptionKey(config.APP_ENCRYPTION_KEY);
  const policy = policyFor(config.NODE_ENV);

  const onTenant = async <T>(req: HttpRequest, action: PolicyAction, fn: (client: Parameters<Parameters<typeof withScope>[2]>[0], tenantId: string, principal: Principal) => Promise<T>) => {
    const principal = await principalOf(req);
    if (principal.kind !== 'apiKey') throw forbidden('use uma chave de API do estabelecimento');
    const decision = await preAuthorize(pool, principal, action, { tenantId: principal.tenantId, billId: null }, req.correlationId);
    return withScope(pool, { kind: 'tenant', tenantId: principal.tenantId }, async (client) => {
      await auditAllowed(client, principal, decision, { tenantId: principal.tenantId, billId: null }, req.correlationId);
      return fn(client, principal.tenantId, principal);
    });
  };

  router.post('/v1/webhook-endpoints', async (req) => {
    const input = parseBody(createSchema, req);
    const body = await onTenant(req, 'webhooks.manage', async (client, tenantId) => {
      try {
        const created = await createEndpoint(client, tenantId, { url: input.url, events: input.events, ...(input.description ? { description: input.description } : {}) }, key, policy);
        return {
          endpoint: { id: created.id, url: input.url, events: input.events, active: true },
          secret: created.secret,
          notice: 'guarde o segredo agora: ele não será mostrado de novo',
        };
      } catch (e) {
        if (e instanceof DestinationError) throw unprocessable(e.code, e.message);
        throw e;
      }
    });
    return { status: 201, body };
  });

  router.get('/v1/webhook-endpoints', async (req) => {
    const body = await onTenant(req, 'webhooks.manage', async (client) => {
      const { rows } = await client.query('SELECT id, url, events, description, active, created_at FROM webhook_endpoints ORDER BY created_at');
      return { endpoints: rows.map((r) => ({ id: r.id, url: r.url, events: r.events, description: r.description, active: r.active, createdAt: r.created_at })) };
    });
    return { status: 200, body };
  });

  router.get('/v1/webhook-deliveries', async (req) => {
    const status = req.query.get('status');
    if (status && !['PENDING', 'RETRYING', 'DELIVERED', 'DEAD'].includes(status)) throw unprocessable('VALIDATION_ERROR', 'status inválido');
    const limit = Math.min(Math.max(Number(req.query.get('limit') ?? 50) || 50, 1), 200);
    const body = await onTenant(req, 'webhooks.manage', async (client) => {
      const { rows } = await client.query(
        `SELECT id, endpoint_id, event_id, event_type, status, attempts, next_attempt_at, last_status_code, last_error, created_at, delivered_at
           FROM webhook_deliveries WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT $2`,
        [status, limit],
      );
      return {
        deliveries: rows.map((r) => ({
          id: r.id,
          endpointId: r.endpoint_id,
          eventId: r.event_id,
          eventType: r.event_type,
          status: r.status,
          attempts: r.attempts,
          nextAttemptAt: r.status === 'PENDING' || r.status === 'RETRYING' ? r.next_attempt_at : null,
          lastStatusCode: r.last_status_code,
          lastError: r.last_error,
          createdAt: r.created_at,
          deliveredAt: r.delivered_at,
        })),
      };
    });
    return { status: 200, body };
  });

  router.post('/v1/webhook-deliveries/:id/retry', async (req) => {
    const id = param(req, 'id');
    const body = await onTenant(req, 'webhooks.manage', async (client) => {
      const { rows } = await client.query<{ status: string }>('SELECT status FROM webhook_deliveries WHERE id = $1 FOR UPDATE', [id]);
      const row = rows[0];
      if (!row) throw notFound('entrega');
      if (row.status === 'DELIVERED') throw conflict('ALREADY_DELIVERED', 'entrega já confirmada pelo destino');
      await client.query("UPDATE webhook_deliveries SET status = 'PENDING', attempts = 0, next_attempt_at = $2 WHERE id = $1", [id, deps.clock.now()]);
      return { delivery: { id, status: 'PENDING' } };
    });
    return { status: 200, body };
  });
}
