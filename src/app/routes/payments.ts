// Rotas de pagamento (03 § Rotas): criar (Idempotency-Key), confirmar/recusar manual, simular (sandbox),
// estorno / devolução manual e webhook assinado de provedor.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withScope } from '../../infra/db/tx.ts';
import type { Router } from '../../infra/http/router.ts';
import { PAYMENT_EVENT_KINDS } from '../../modules/payments/state-machine.ts';
import * as payments from '../../modules/payments/service.ts';
import { processProviderWebhook } from '../../modules/payments/webhooks.ts';
import { billView } from '../../modules/shared-bills/view.ts';
import { centsToJson } from '../../modules/split/money.ts';
import { billScope, viewerOf } from '../auth.ts';
import type { AppDeps } from '../deps.ts';
import { conflict, notFound, toAppError, unprocessable } from '../errors.ts';
import { auditAllowed, preAuthorize } from '../guard.ts';
import { cents, param, parseBody, uuid } from '../http-helpers.ts';
import { beginIdempotent, completeIdempotent, idempotencyKeyOf, requestHash } from '../idempotency.ts';
import { routeKit } from './common.ts';
import { errorBody } from '../../infra/http/server.ts';

export const paymentCreateSchema = z
  .object({
    billId: uuid,
    participantId: uuid,
    amountCents: cents.optional(),
    method: z.enum(['MANUAL', 'SANDBOX']).default('MANUAL'),
  })
  .strict();

export const refundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PROVIDER'), billId: uuid, paymentId: uuid, amountCents: cents.optional() }).strict(),
  z.object({ kind: z.literal('MANUAL_RECORD'), billId: uuid, participantId: uuid, amountCents: cents }).strict(),
]);

export const simulateSchema = z
  .object({
    kind: z.enum(PAYMENT_EVENT_KINDS).default('CONFIRMED'),
    amountCents: z.number().int().positive().optional(),
    eventId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/).optional(),
  })
  .strict();

export function registerPaymentRoutes(router: Router, deps: AppDeps): void {
  const { pool, config, clock, providers } = deps;
  const { principalOf, ctxOf, onBill, runOnBill } = routeKit(deps);

  router.post('/v1/payments', async (req) => {
    const input = parseBody(paymentCreateSchema, req);
    if (input.method === 'SANDBOX' && !providers.sandbox) throw unprocessable('METHOD_NOT_AVAILABLE', 'sandbox desligado neste ambiente');
    const key = idempotencyKeyOf(req.headers);
    const principal = await principalOf(req);
    const scope = billScope(principal, input.billId);
    const decision = await preAuthorize(pool, principal, 'payment.create', { tenantId: scope.tenantId, billId: input.billId }, req.correlationId);
    const idem = { tenantId: scope.tenantId, billId: scope.kind === 'bill' ? scope.billId : null, key, hash: requestHash('POST', '/v1/payments', req.body) };

    // Fase 1: trava a conta, idempotência, reserva o saldo da parte.
    const phase1 = await withScope(pool, scope, async (client) => {
      const ctx = ctxOf(principal, scope.tenantId, req);
      await client.query('SELECT 1 FROM bills WHERE id = $1 FOR UPDATE', [input.billId]);
      const begun = await beginIdempotent(client, idem, ctx.now);
      if (begun.kind === 'replay') return { replay: begun };
      await auditAllowed(client, principal, decision, { tenantId: scope.tenantId, billId: input.billId }, req.correlationId);
      await client.query('SAVEPOINT reserve');
      try {
        const created = await payments.reservePayment(client, ctx, {
          billId: input.billId,
          participantId: input.participantId,
          method: input.method,
          ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
        });
        if (!created.needsProviderCall) {
          const body = { payment: paymentJson(created), bill: await billView(client, input.billId, { viewer: viewerOf(principal) }) };
          await completeIdempotent(client, idem, 201, body);
          return { done: { status: 201, body } };
        }
        return { created };
      } catch (error) {
        // Erro de regra também é a resposta "dessa chave": grava para a repetição responder igual.
        const appError = toAppError(error);
        if (appError.status >= 500) throw error;
        await client.query('ROLLBACK TO SAVEPOINT reserve');
        const body = errorBody(appError, req.correlationId);
        await completeIdempotent(client, idem, appError.status, body);
        return { done: { status: appError.status, body } };
      }
    });
    if ('replay' in phase1 && phase1.replay) return { status: phase1.replay.status, body: phase1.replay.body, headers: { 'Idempotent-Replayed': 'true' } };
    if ('done' in phase1 && phase1.done) return phase1.done;
    const created = (phase1 as { created: payments.PaymentCreated }).created;

    // Fase 2: chamada ao provedor FORA da trava da conta; depois grava a referência.
    const provider = providers.sandbox as NonNullable<typeof providers.sandbox>;
    let charge: Awaited<ReturnType<typeof provider.createPayment>> | undefined;
    let providerError: unknown;
    try {
      charge = await provider.createPayment();
    } catch (e) {
      providerError = e;
    }
    const body = await withScope(pool, scope, async (client) => {
      const ctx = ctxOf(principal, scope.tenantId, req);
      if (!charge) {
        await payments.applyEvent(client, ctx, input.billId, created.paymentId, { eventId: `create-failed:${created.paymentId}`, kind: 'FAILED' }, { origin: 'provider:create' });
      } else {
        await payments.attachProviderReference(client, ctx, input.billId, created.paymentId, provider, charge.reference);
      }
      const response = {
        payment: {
          ...paymentJson({ ...created, status: charge ? 'PENDING' : 'FAILED' }),
          ...(charge ? { sandbox: { reference: charge.reference, ...charge.instructions } } : { error: 'falha ao criar cobrança no provedor' }),
        },
        bill: await billView(client, input.billId, { viewer: viewerOf(principal) }),
      };
      await completeIdempotent(client, idem, charge ? 201 : 502, response);
      return response;
    });
    if (providerError) deps.logger.error('provider_create_failed', { provider: provider.name, message: (providerError as Error).message });
    return { status: charge ? 201 : 502, body };
  });

  const manualDecision = (kind: 'CONFIRMED' | 'REJECTED') =>
    onBill(kind === 'CONFIRMED' ? 'payment.confirm_manual' : 'payment.reject_manual', async (client, ctx, req, billId) => {
      const paymentId = param(req, 'pid');
      const p = await payments.paymentForBill(client, billId, paymentId);
      if (p.method !== 'MANUAL') throw conflict('NOT_MANUAL', 'só pagamento manual é confirmado pelo organizador');
      const applied = await payments.applyEvent(client, ctx, billId, paymentId, { eventId: `organizer:${randomUUID()}`, kind }, { origin: 'organizer' });
      if (applied.outcome === 'IGNORED') throw conflict('PAYMENT_NOT_PENDING', `pagamento não está pendente (status ${applied.payment.status})`);
      return { paymentStatus: applied.payment.status, cases: applied.cases.length };
    });

  router.post('/v1/bills/:id/payments/:pid/confirm', manualDecision('CONFIRMED'));
  router.post('/v1/bills/:id/payments/:pid/reject', manualDecision('REJECTED'));

  router.post('/v1/bills/:id/payments/:pid/simulate', async (req) => {
    const sandbox = providers.sandbox;
    if (!sandbox || !config.SANDBOX_ENABLED) throw notFound('rota');
    const billId = param(req, 'id');
    const paymentId = param(req, 'pid');
    const input = parseBody(simulateSchema, req);
    // Autoriza como criação de pagamento (convidado testando o próprio pagamento) e acha a referência.
    const reference = (await runOnBill(
      req,
      billId,
      'payment.create',
      async (client, _ctx, _req, id) => {
        const p = await payments.paymentForBill(client, id, paymentId);
        if (p.method !== 'SANDBOX' || !p.provider_reference) throw conflict('NOT_SANDBOX', 'só pagamento sandbox pode ser simulado');
        return p.provider_reference;
      },
      { respond: 'result' },
    )) as string;
    // O evento passa pelo MESMO caminho de um webhook real: assinatura, roteamento, deduplicação.
    const hook = sandbox.buildWebhook(
      { eventId: input.eventId ?? `sim:${randomUUID()}`, reference, kind: input.kind, ...(input.amountCents ? { amountCents: input.amountCents } : {}) },
      clock.now(),
    );
    const result = await processProviderWebhook({ pool, providers, clock }, sandbox.name, Buffer.from(hook.body), { 'x-sandbox-signature': hook.signature }, req.correlationId);
    const principal = await principalOf(req);
    const bill = await withScope(pool, billScope(principal, billId), (c) => billView(c, billId, { viewer: viewerOf(principal) }));
    return { status: 200, body: { duplicate: result.duplicate, outcome: result.applied?.outcome ?? 'DUPLICATE', bill } };
  });

  router.post('/v1/refunds', async (req) => {
    const input = parseBody(refundSchema, req);
    if (input.kind === 'PROVIDER') {
      const body = await runOnBill(req, input.billId, 'refund.request', async (client, ctx) => {
        const applied = await payments.requestProviderRefund(client, ctx, input.billId, input.paymentId, input.amountCents);
        return { refund: { paymentId: input.paymentId, paymentStatus: applied.payment.status, refundedCents: centsToJson(applied.payment.refundedCents) } };
      });
      return { status: 201, body };
    }
    const body = await runOnBill(req, input.billId, 'refund.record_manual', async (client, ctx) => {
      const r = await payments.recordManualRefund(client, ctx, input.billId, input.participantId, input.amountCents);
      return { refund: { participantId: input.participantId, amountCents: centsToJson(input.amountCents), resolvedCases: r.resolvedCases } };
    });
    return { status: 201, body };
  });

  router.post('/v1/webhooks/payments/:provider', async (req) => {
    const name = req.params.provider ?? '';
    if (!/^[a-z0-9-]{1,40}$/.test(name)) throw notFound('provedor');
    const result = await processProviderWebhook({ pool, providers, clock }, name, req.rawBody, req.headers, req.correlationId);
    return { status: 200, body: { received: true, duplicate: result.duplicate, outcome: result.applied?.outcome ?? 'DUPLICATE' } };
  });
}

function paymentJson(p: { paymentId: string; status: string; amountCents: bigint; method: string; expiresAt: Date }) {
  return { id: p.paymentId, status: p.status, amountCents: centsToJson(p.amountCents), method: p.method, expiresAt: p.expiresAt.toISOString() };
}
