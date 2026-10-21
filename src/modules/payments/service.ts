// Pagamentos persistidos (02 § Pagamentos, D3, D12). Um único núcleo aplica eventos — vindos de
// webhook de provedor, do organizador (manual), do worker (expiração) ou de estorno — sempre com a
// conta travada, ledger, casos CBR e reconciliação na MESMA transação.

import { randomUUID } from 'node:crypto';
import { AppError, conflict, notFound, unprocessable } from '../../app/errors.ts';
import type { PoolClient } from '../../infra/db/pool.ts';
import { resolveKnowledge } from '../expert/library.ts';
import { appendLedger } from '../ledger/ledger-repo.ts';
import { refreshBillState, loadReconciliation, paymentFromRow } from '../reconciliation/service.ts';
import type { BillState } from '../reconciliation/reconcile.ts';
import type { ServiceContext } from '../service-context.ts';
import { knowledgeContext, loadBill, type BillRow } from '../shared-bills/repo.ts';
import type { PaymentProvider } from './providers.ts';
import {
  applyPaymentEvent,
  CONFIRMED_STATUSES,
  netPaidCents,
  PROCESSING_STATUSES,
  type CbrCaseKind,
  type PaymentEvent,
  type PaymentMethod,
  type PaymentOutcome,
  type PaymentSnapshot,
} from './state-machine.ts';

const PAYABLE_STATES: readonly BillState[] = ['OPEN', 'PARTIALLY_PAID', 'SETTLEMENT_PENDING', 'REOPENED'];

async function lockBill(client: PoolClient, billId: string): Promise<BillRow> {
  const bill = await loadBill(client, billId, { forUpdate: true });
  if (!bill) throw notFound('conta');
  return bill;
}

async function lockPayment(client: PoolClient, billId: string, paymentId: string): Promise<PaymentSnapshot & { provider_reference: string | null }> {
  const { rows } = await client.query(
    `SELECT id, participant_id, method, amount_cents, status, refunded_cents, chargedback_cents, deferred, provider_reference
       FROM payments WHERE bill_id = $1 AND id = $2 FOR UPDATE`,
    [billId, paymentId],
  );
  const row = rows[0];
  if (!row) throw notFound('pagamento');
  return { ...paymentFromRow(row), provider_reference: row.provider_reference };
}

function ledgerDraft(ctx: ServiceContext, billId: string, type: Parameters<typeof appendLedger>[2]['type'], payload: Parameters<typeof appendLedger>[2]['payload']) {
  return { billId, type, payload, actor: ctx.actor, correlationId: ctx.correlationId, occurredAt: ctx.now.toISOString() };
}

export async function openCase(
  client: PoolClient,
  ctx: ServiceContext,
  billId: string,
  kind: CbrCaseKind | 'OVERPAYMENT' | 'REFUND_AFTER_SETTLEMENT' | 'ERP_DIVERGENCE',
  data: { paymentId?: string; participantId?: string; features: string[]; evidence: Record<string, unknown> },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO cbr_cases (tenant_id, bill_id, kind, payment_id, participant_id, features, evidence, correlation_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING id`,
    [ctx.tenantId, billId, kind, data.paymentId ?? null, data.participantId ?? null, data.features, JSON.stringify(data.evidence), ctx.correlationId, ctx.now],
  );
  return (rows[0] as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Criação

export interface CreatePaymentInput {
  billId: string;
  participantId: string;
  amountCents?: bigint;
  method: 'MANUAL' | 'SANDBOX';
}

export interface PaymentCreated {
  paymentId: string;
  status: PaymentSnapshot['status'];
  amountCents: bigint;
  method: PaymentMethod;
  expiresAt: Date;
  needsProviderCall: boolean;
}

/**
 * Fase 1 (com a conta travada): valida saldo da parte, reserva (CREATED/PENDING) e grava o ledger.
 * Para provedor remoto, a chamada ao provedor acontece DEPOIS, fora da trava (fase 2).
 */
export async function reservePayment(client: PoolClient, ctx: ServiceContext, input: CreatePaymentInput): Promise<PaymentCreated> {
  const bill = await lockBill(client, input.billId);
  if (bill.state === 'DRAFT') throw conflict('SPLIT_NOT_CONFIRMED', 'a divisão ainda não foi confirmada');
  if (bill.state === 'CANCELLED') throw conflict('BILL_CANCELLED', 'conta cancelada');
  if (!PAYABLE_STATES.includes(bill.state)) throw conflict('BILL_SETTLED', 'conta já quitada');
  const participant = await client.query('SELECT 1 FROM participants WHERE bill_id = $1 AND id = $2', [bill.id, input.participantId]);
  if (participant.rowCount === 0) throw notFound('participante');

  const { reconciliation } = await loadReconciliation(client, bill);
  const share = reconciliation.participants.find((p) => p.participantId === input.participantId);
  const available = share?.availableToPayCents ?? 0n;
  if (available === 0n) throw conflict('NOTHING_TO_PAY', 'esta parte não tem saldo a pagar (paga ou já em processamento)');
  const amount = input.amountCents ?? available;
  if (amount <= 0n) throw unprocessable('INVALID_AMOUNT', 'valor deve ser positivo');
  if (amount > available) {
    throw conflict('AMOUNT_EXCEEDS_BALANCE', 'valor maior que o saldo da parte', { availableToPayCents: Number(available) });
  }

  const expiry = await resolveKnowledge(client, 'PAYMENT.EXPIRY', knowledgeContext(bill), ctx.now);
  const minutes = input.method === 'MANUAL' ? expiry.content.manualMinutes : expiry.content.sandboxMinutes;
  const expiresAt = new Date(ctx.now.getTime() + minutes * 60_000);
  const paymentId = randomUUID();
  // Manual: fica pendente até o organizador confirmar. Provedor: CREATED até a fase 2 obter a referência.
  const status = input.method === 'MANUAL' ? 'PENDING' : 'CREATED';
  await client.query(
    `INSERT INTO payments (id, tenant_id, bill_id, participant_id, method, amount_cents, status, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [paymentId, ctx.tenantId, bill.id, input.participantId, input.method, amount, status, expiresAt, ctx.now],
  );
  await client.query('INSERT INTO payment_expiry_index (payment_id, tenant_id, bill_id, expires_at) VALUES ($1, $2, $3, $4)', [
    paymentId,
    ctx.tenantId,
    bill.id,
    expiresAt,
  ]);
  const base = { paymentId, participantId: input.participantId, amountCents: amount, method: input.method };
  await appendLedger(client, ctx.tenantId, ledgerDraft(ctx, bill.id, 'PAYMENT_CREATED', base));
  if (status === 'PENDING') await appendLedger(client, ctx.tenantId, ledgerDraft(ctx, bill.id, 'PAYMENT_PENDING', base));
  await refreshBillState(client, ctx, bill);
  return { paymentId, status, amountCents: amount, method: input.method, expiresAt, needsProviderCall: input.method !== 'MANUAL' };
}

/** Fase 2 (nova transação): grava a referência do provedor e passa a PENDING. */
export async function attachProviderReference(
  client: PoolClient,
  ctx: ServiceContext,
  billId: string,
  paymentId: string,
  provider: PaymentProvider,
  reference: string,
): Promise<void> {
  await lockBill(client, billId);
  const p = await lockPayment(client, billId, paymentId);
  if (p.status !== 'CREATED') return;
  await client.query("UPDATE payments SET status = 'PENDING', provider_reference = $3, updated_at = $4 WHERE bill_id = $1 AND id = $2", [
    billId,
    paymentId,
    reference,
    ctx.now,
  ]);
  await client.query('INSERT INTO provider_routes (provider, reference, tenant_id, bill_id, payment_id) VALUES ($1, $2, $3, $4, $5)', [
    provider.name,
    reference,
    ctx.tenantId,
    billId,
    paymentId,
  ]);
  await appendLedger(
    client,
    ctx.tenantId,
    ledgerDraft(ctx, billId, 'PAYMENT_PENDING', { paymentId, participantId: p.participantId, amountCents: p.amountCents, provider: provider.name, reference }),
  );
}

// ---------------------------------------------------------------------------
// Núcleo: aplicar um evento ao pagamento

export interface EventSource {
  /** 'organizer', 'worker:expiry', 'provider:sandbox', 'refund' … */
  origin: string;
  provider?: string;
  reference?: string;
}

export interface AppliedEvent {
  outcome: PaymentOutcome;
  payment: PaymentSnapshot;
  state: BillState;
  previousState: BillState;
  cases: string[];
}

export async function applyEvent(
  client: PoolClient,
  ctx: ServiceContext,
  billId: string,
  paymentId: string,
  event: PaymentEvent,
  source: EventSource,
): Promise<AppliedEvent> {
  const bill = await lockBill(client, billId);
  const current = await lockPayment(client, billId, paymentId);
  const before = await loadReconciliation(client, bill);
  const t = applyPaymentEvent(current, event);
  const p = t.payment;
  const cases: string[] = [];

  if (t.outcome !== 'IGNORED') {
    const firstConfirmation = !CONFIRMED_STATUSES.includes(current.status) && CONFIRMED_STATUSES.includes(p.status);
    await client.query(
      `UPDATE payments SET status = $3, refunded_cents = $4, chargedback_cents = $5, deferred = $6::jsonb, updated_at = $7,
              confirmed_at = CASE WHEN $8 THEN $7 ELSE confirmed_at END
        WHERE bill_id = $1 AND id = $2`,
      [
        billId,
        paymentId,
        p.status,
        p.refundedCents,
        p.chargedbackCents,
        JSON.stringify(p.deferred.map((d) => ({ eventId: d.eventId, kind: d.kind, ...(d.amountCents !== undefined ? { amountCents: Number(d.amountCents) } : {}) }))),
        ctx.now,
        firstConfirmation,
      ],
    );
  }
  if (!PROCESSING_STATUSES.includes(p.status)) {
    await client.query('DELETE FROM payment_expiry_index WHERE payment_id = $1', [paymentId]);
  }
  for (const l of t.effects.ledger) {
    await appendLedger(
      client,
      ctx.tenantId,
      ledgerDraft(ctx, billId, l.type, {
        paymentId,
        participantId: p.participantId,
        amountCents: l.amountCents,
        eventId: l.eventId,
        origin: source.origin,
        ...(source.provider ? { provider: source.provider } : {}),
        ...(source.reference ? { reference: source.reference } : {}),
      }),
    );
  }
  for (const c of t.effects.cases) {
    cases.push(
      await openCase(client, ctx, billId, c.kind, {
        paymentId,
        participantId: p.participantId,
        features: [`kind:${c.kind}`, `method:${p.method}`, `status_before:${current.status}`, `event:${event.kind}`, `segment:${bill.kind}`],
        evidence: { eventId: c.eventId, origin: source.origin, statusBefore: current.status, statusAfter: p.status },
      }),
    );
  }

  const refreshed = await refreshBillState(client, ctx, await lockBill(client, billId));

  // Exceções derivadas da conciliação (não do pagamento isolado).
  const prevShare = before.reconciliation.participants.find((x) => x.participantId === p.participantId);
  const newShare = refreshed.reconciliation.participants.find((x) => x.participantId === p.participantId);
  if (newShare && newShare.refundDueCents > (prevShare?.refundDueCents ?? 0n)) {
    cases.push(
      await openCase(client, ctx, billId, 'OVERPAYMENT', {
        paymentId,
        participantId: p.participantId,
        features: ['kind:OVERPAYMENT', `method:${p.method}`, `segment:${bill.kind}`],
        evidence: { refundDueCents: Number(newShare.refundDueCents), dueCents: Number(newShare.dueCents), paidCents: Number(newShare.paidCents) },
      }),
    );
  }
  if (refreshed.previous === 'SETTLED' && refreshed.state === 'REOPENED' && t.effects.ledger.some((l) => l.type === 'PAYMENT_REFUNDED')) {
    cases.push(
      await openCase(client, ctx, billId, 'REFUND_AFTER_SETTLEMENT', {
        paymentId,
        participantId: p.participantId,
        features: ['kind:REFUND_AFTER_SETTLEMENT', `method:${p.method}`, `segment:${bill.kind}`],
        evidence: { refundedCents: Number(p.refundedCents) },
      }),
    );
  }
  return { outcome: t.outcome, payment: p, state: refreshed.state, previousState: refreshed.previous, cases };
}

// ---------------------------------------------------------------------------
// Estorno e devolução manual

export async function requestProviderRefund(
  client: PoolClient,
  ctx: ServiceContext,
  billId: string,
  paymentId: string,
  amountCents: bigint | undefined,
): Promise<AppliedEvent> {
  await lockBill(client, billId);
  const p = await lockPayment(client, billId, paymentId);
  if (p.method === 'MANUAL') {
    throw unprocessable('USE_MANUAL_REFUND_RECORD', 'pagamento manual: registre a devolução feita ao participante (kind MANUAL_RECORD)');
  }
  if (p.method !== 'SANDBOX') {
    throw new AppError(501, 'REFUND_NOT_AVAILABLE', 'estorno via este provedor ainda não está disponível (PSP real bloqueado)');
  }
  const net = netPaidCents(p);
  if (net === 0n) throw conflict('NOTHING_TO_REFUND', 'pagamento sem valor confirmado a estornar');
  const amount = amountCents ?? net;
  if (amount > net) throw unprocessable('AMOUNT_EXCEEDS_NET', 'valor maior que o líquido do pagamento', { netPaidCents: Number(net) });
  // Sandbox: o provedor "confirma" o estorno na hora. Com PSP real, a confirmação chega por webhook.
  return applyEvent(client, ctx, billId, paymentId, { eventId: `refund:${randomUUID()}`, kind: 'REFUNDED', amountCents: amount }, {
    origin: 'refund',
    provider: 'sandbox',
  });
}

/** D3 — o organizador registra que devolveu o excedente de um participante. */
export async function recordManualRefund(
  client: PoolClient,
  ctx: ServiceContext,
  billId: string,
  participantId: string,
  amountCents: bigint,
): Promise<{ state: BillState; resolvedCases: number }> {
  const bill = await lockBill(client, billId);
  const { reconciliation, confirmed } = await loadReconciliation(client, bill);
  if (!confirmed) throw conflict('SPLIT_NOT_CONFIRMED', 'a divisão ainda não foi confirmada');
  const share = reconciliation.participants.find((p) => p.participantId === participantId);
  if (!share) throw notFound('participante');
  if (amountCents <= 0n) throw unprocessable('INVALID_AMOUNT', 'valor deve ser positivo');
  if (amountCents > share.refundDueCents) {
    throw unprocessable('REFUND_EXCEEDS_DUE', 'valor maior que o excedente a devolver', { refundDueCents: Number(share.refundDueCents) });
  }
  await client.query('INSERT INTO manual_refunds (tenant_id, bill_id, participant_id, amount_cents, created_at) VALUES ($1, $2, $3, $4, $5)', [
    ctx.tenantId,
    billId,
    participantId,
    amountCents,
    ctx.now,
  ]);
  await appendLedger(client, ctx.tenantId, ledgerDraft(ctx, billId, 'REFUND_RECORDED', { participantId, amountCents }));
  let resolvedCases = 0;
  if (amountCents === share.refundDueCents) {
    const res = await client.query(
      `UPDATE cbr_cases SET status = 'RESOLVED', decision = 'REFUND_RECORDED', outcome = 'excedente devolvido pelo organizador',
              resolved_by = $3, resolved_at = $4
        WHERE bill_id = $1 AND participant_id = $2 AND kind = 'OVERPAYMENT' AND status = 'OPEN'`,
      [billId, participantId, ctx.actor.id, ctx.now],
    );
    resolvedCases = res.rowCount ?? 0;
  }
  const refreshed = await refreshBillState(client, ctx, await lockBill(client, billId));
  return { state: refreshed.state, resolvedCases };
}

export async function paymentForBill(client: PoolClient, billId: string, paymentId: string) {
  const { rows } = await client.query('SELECT id, method, status, provider_reference FROM payments WHERE bill_id = $1 AND id = $2', [billId, paymentId]);
  const row = rows[0] as { id: string; method: string; status: string; provider_reference: string | null } | undefined;
  if (!row) throw notFound('pagamento');
  return row;
}
