// Conciliação persistida: carrega partes e pagamentos, concilia (puro), deriva o estado (D6) e,
// se mudou, grava no bill e no ledger. Invariante falhou → exceção → a transação inteira é abortada.

import type { PoolClient } from '../../infra/db/pool.ts';
import { appendLedger } from '../ledger/ledger-repo.ts';
import type { PaymentSnapshot } from '../payments/state-machine.ts';
import type { ServiceContext } from '../service-context.ts';
import { loadAllocations, loadSplitVersion, type BillRow } from '../shared-bills/repo.ts';
import { deriveBillState, reconcile, type BillState, type Reconciliation } from './reconcile.ts';

interface PaymentRow {
  id: string;
  participant_id: string;
  method: PaymentSnapshot['method'];
  amount_cents: bigint;
  status: PaymentSnapshot['status'];
  refunded_cents: bigint;
  chargedback_cents: bigint;
  deferred: { eventId: string; kind: PaymentSnapshot['deferred'][number]['kind']; amountCents?: number }[];
}

export function paymentFromRow(r: PaymentRow): PaymentSnapshot {
  return {
    id: r.id,
    participantId: r.participant_id,
    method: r.method,
    amountCents: r.amount_cents,
    status: r.status,
    refundedCents: r.refunded_cents,
    chargedbackCents: r.chargedback_cents,
    deferred: r.deferred.map((d) =>
      d.amountCents === undefined ? { eventId: d.eventId, kind: d.kind } : { eventId: d.eventId, kind: d.kind, amountCents: BigInt(d.amountCents) },
    ),
  };
}

export async function loadPayments(client: PoolClient, billId: string): Promise<PaymentSnapshot[]> {
  const { rows } = await client.query<PaymentRow>(
    `SELECT id, participant_id, method, amount_cents, status, refunded_cents, chargedback_cents, deferred
       FROM payments WHERE bill_id = $1 ORDER BY created_at, id`,
    [billId],
  );
  return rows.map(paymentFromRow);
}

export interface BillReconciliation {
  reconciliation: Reconciliation;
  /** Conta com divisão confirmada? */
  confirmed: boolean;
}

export async function loadReconciliation(client: PoolClient, bill: BillRow): Promise<BillReconciliation> {
  if (bill.active_split_version === null) {
    return { confirmed: false, reconciliation: reconcile({ totalCents: 0n, allocations: [], payments: [] }) };
  }
  const version = await loadSplitVersion(client, bill.id, bill.active_split_version);
  if (!version) throw new Error(`versão ativa ${bill.active_split_version} ausente`);
  const [allocations, payments, organizer, refunds] = await Promise.all([
    loadAllocations(client, bill.id, bill.active_split_version),
    loadPayments(client, bill.id),
    client.query<{ id: string }>('SELECT id FROM participants WHERE bill_id = $1 AND is_organizer', [bill.id]),
    client.query<{ participant_id: string; total: bigint }>(
      'SELECT participant_id, SUM(amount_cents)::bigint AS total FROM manual_refunds WHERE bill_id = $1 GROUP BY participant_id',
      [bill.id],
    ),
  ]);
  const organizerId = organizer.rows[0]?.id;
  const refundBy = new Map(refunds.rows.map((r) => [r.participant_id, r.total]));
  // Participantes sem alocação na versão ativa (entraram depois) têm devido zero.
  const allocated = new Set(allocations.map((a) => a.participant_id));
  const extra = new Set(payments.map((p) => p.participantId).filter((id) => !allocated.has(id)));
  const reconciliation = reconcile({
    totalCents: version.total_cents,
    allocations: [
      ...allocations.map((a) => ({
        participantId: a.participant_id,
        dueCents: a.total_cents,
        selfSettledCents: bill.collection_model === 'ORGANIZER_COLLECTS' && a.participant_id === organizerId ? a.total_cents : 0n,
        refundRecordedCents: refundBy.get(a.participant_id) ?? 0n,
      })),
      ...[...extra].map((participantId) => ({
        participantId,
        dueCents: 0n,
        selfSettledCents: 0n,
        refundRecordedCents: refundBy.get(participantId) ?? 0n,
      })),
    ],
    payments,
  });
  return { confirmed: true, reconciliation };
}

/** Recalcula o estado; se mudou, atualiza a conta e registra BILL_STATE_CHANGED no ledger. */
export async function refreshBillState(
  client: PoolClient,
  ctx: ServiceContext,
  bill: BillRow,
  opts: { cancelled?: boolean } = {},
): Promise<{ state: BillState; previous: BillState; reconciliation: Reconciliation }> {
  const { reconciliation, confirmed } = await loadReconciliation(client, bill);
  const state = deriveBillState({
    previous: bill.state,
    splitConfirmed: confirmed,
    cancelled: opts.cancelled ?? bill.state === 'CANCELLED',
    reconciliation,
  });
  if (state !== bill.state) {
    await client.query('UPDATE bills SET state = $2, updated_at = $3, row_version = row_version + 1 WHERE id = $1', [
      bill.id,
      state,
      ctx.now,
    ]);
    await appendLedger(client, ctx.tenantId, {
      billId: bill.id,
      type: 'BILL_STATE_CHANGED',
      payload: { from: bill.state, to: state },
      actor: ctx.actor,
      correlationId: ctx.correlationId,
      occurredAt: ctx.now.toISOString(),
    });
  }
  return { state, previous: bill.state, reconciliation };
}
