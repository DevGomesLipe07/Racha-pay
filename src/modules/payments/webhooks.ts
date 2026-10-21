// Entrada de webhook de provedor: assinatura + anti-replay (no adapter) → roteamento sem tenant
// (função SECURITY DEFINER) → escopo da conta → aplica o evento → deduplicação por (provider, event_id).
// Duplicado: a transação é desfeita e nada muda (resposta 200 { duplicate: true }).

import type { Clock } from '../../infra/clock.ts';
import { sha256Hex } from '../../infra/crypto/hash.ts';
import type { Pool } from '../../infra/db/pool.ts';
import { withoutScope, withScope } from '../../infra/db/tx.ts';
import { decide } from '../policies/policy-engine.ts';
import type { ServiceContext } from '../service-context.ts';
import type { ProviderRegistry } from './providers.ts';
import { applyEvent, type AppliedEvent } from './service.ts';
import { AppError, notFound } from '../../app/errors.ts';
import { WebhookVerificationError } from './providers.ts';

class DuplicateEvent extends Error {}

export interface WebhookResult {
  duplicate: boolean;
  applied?: AppliedEvent;
  billId?: string;
}

export async function processProviderWebhook(
  deps: { pool: Pool; providers: ProviderRegistry; clock: Clock },
  providerName: string,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  correlationId: string,
): Promise<WebhookResult> {
  const provider = deps.providers.get(providerName);
  if (!provider) throw notFound('provedor');
  const now = deps.clock.now();
  let event;
  try {
    event = provider.verifyWebhook(rawBody, headers, now);
  } catch (e) {
    if (e instanceof WebhookVerificationError) throw new AppError(401, e.code, e.message);
    throw e;
  }
  const { rows } = await withoutScope(deps.pool, (c) =>
    c.query<{ tenant_id: string; bill_id: string; payment_id: string }>('SELECT * FROM rp_resolve_provider_route($1, $2)', [provider.name, event.reference]),
  );
  const route = rows[0];
  if (!route) throw new AppError(404, 'UNKNOWN_REFERENCE', 'referência de pagamento desconhecida');

  const actor = { type: 'SYSTEM' as const, id: `provider:${provider.name}`, scopes: ['payments:provider'] };
  const decision = decide('payment.apply_provider_event', actor);
  if (!decision.allowed) throw new AppError(403, 'FORBIDDEN', decision.reason);

  try {
    return await withScope(deps.pool, { kind: 'bill', tenantId: route.tenant_id, billId: route.bill_id }, async (client) => {
      const ctx: ServiceContext = { tenantId: route.tenant_id, actor: { type: actor.type, id: actor.id }, correlationId, now };
      const applied = await applyEvent(
        client,
        ctx,
        route.bill_id,
        route.payment_id,
        event.amountCents === undefined ? { eventId: event.eventId, kind: event.kind } : { eventId: event.eventId, kind: event.kind, amountCents: event.amountCents },
        { origin: `provider:${provider.name}`, provider: provider.name, reference: event.reference },
      );
      const inserted = await client.query(
        `INSERT INTO provider_events (tenant_id, bill_id, payment_id, provider, event_id, kind, outcome, payload_sha256, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
        [route.tenant_id, route.bill_id, route.payment_id, provider.name, event.eventId, event.kind, applied.outcome, sha256Hex(rawBody), now],
      );
      if (inserted.rowCount === 0) throw new DuplicateEvent();
      await client.query(
        `INSERT INTO audit_log (tenant_id, bill_id, actor_type, actor_id, action, allowed, reason, policy_version, correlation_id)
         VALUES ($1, $2, 'SYSTEM', $3, $4, true, $5, $6, $7)`,
        [route.tenant_id, route.bill_id, actor.id, decision.action, decision.reason, decision.policyVersion, correlationId],
      );
      return { duplicate: false, applied, billId: route.bill_id };
    });
  } catch (e) {
    if (e instanceof DuplicateEvent) return { duplicate: true, billId: route.bill_id };
    throw e;
  }
}
