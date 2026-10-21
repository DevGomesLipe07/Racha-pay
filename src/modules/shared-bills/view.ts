// Representação JSON da conta (centavos como inteiros, D14). Nenhuma regra financeira aqui:
// só leitura do que o banco e a conciliação já decidiram.

import type { PoolClient } from '../../infra/db/pool.ts';
import { centsToJson } from '../split/money.ts';
import { loadPayments, loadReconciliation } from '../reconciliation/service.ts';
import { netPaidCents } from '../payments/state-machine.ts';
import { loadAggregate, loadAllocations, loadBill, loadSplitVersion, type BillRow } from './repo.ts';
import { notFound } from '../../app/errors.ts';

const c = centsToJson;

export async function billView(client: PoolClient, billId: string, opts: { viewer: 'organizer' | 'guest' | 'tenant' }) {
  const bill = await loadBill(client, billId);
  if (!bill) throw notFound('conta');
  return renderBill(client, bill, opts);
}

async function renderBill(client: PoolClient, bill: BillRow, opts: { viewer: 'organizer' | 'guest' | 'tenant' }) {
  const agg = await loadAggregate(client, bill);
  const { reconciliation, confirmed } = await loadReconciliation(client, bill);
  const payments = await loadPayments(client, bill.id);
  const version = bill.active_split_version === null ? undefined : await loadSplitVersion(client, bill.id, bill.active_split_version);
  const allocations = bill.active_split_version === null ? [] : await loadAllocations(client, bill.id, bill.active_split_version);
  const allocBy = new Map(allocations.map((a) => [a.participant_id, a]));
  const reconBy = new Map(reconciliation.participants.map((p) => [p.participantId, p]));

  return {
    id: bill.id,
    kind: bill.kind,
    title: bill.title,
    currency: bill.currency,
    collectionModel: bill.collection_model,
    state: bill.state,
    splitMode: bill.split_mode,
    discountCents: c(bill.discount_cents),
    serviceBp: bill.service_bp,
    tipCents: c(bill.tip_cents),
    tableLabel: bill.table_label,
    externalReference: bill.external_reference,
    rowVersion: bill.row_version,
    viewer: opts.viewer,
    split: version
      ? {
          version: version.version,
          kind: version.kind,
          mode: version.mode,
          subtotalCents: c(version.subtotal_cents),
          discountCents: c(version.discount_cents),
          serviceCents: c(version.service_cents),
          tipCents: c(version.tip_cents),
          totalCents: c(version.total_cents),
          confirmedAt: version.created_at.toISOString(),
        }
      : null,
    participants: agg.participants.map((p) => {
      const a = allocBy.get(p.id);
      const r = reconBy.get(p.id);
      return {
        id: p.id,
        name: p.name,
        position: p.position,
        isOrganizer: p.is_organizer,
        percentBp: p.percent_bp,
        manualCents: p.manual_cents === null ? null : c(p.manual_cents),
        share: a
          ? {
              itemsCents: c(a.items_cents),
              discountCents: c(a.discount_cents),
              serviceCents: c(a.service_cents),
              tipCents: c(a.tip_cents),
              totalCents: c(a.total_cents),
            }
          : null,
        balance: r
          ? {
              dueCents: c(r.dueCents),
              paidCents: c(r.paidCents),
              selfSettledCents: c(r.selfSettledCents),
              processingCents: c(r.processingCents),
              unpaidCents: c(r.unpaidCents),
              refundDueCents: c(r.refundDueCents),
              availableToPayCents: c(r.availableToPayCents),
              settled: r.paidCents >= r.dueCents,
            }
          : null,
      };
    }),
    items: agg.items.map((it) => ({
      id: it.id,
      description: it.description,
      unitPriceCents: c(it.unit_price_cents),
      quantity: it.quantity,
      totalCents: c(it.unit_price_cents * BigInt(it.quantity)),
      externalRef: it.external_ref,
      confirmedVersion: it.confirmed_version,
      assignees: agg.assignees.filter((a) => a.item_id === it.id).map((a) => ({ participantId: a.participant_id, weight: a.weight })),
    })),
    payments: payments.map((p) => ({
      id: p.id,
      participantId: p.participantId,
      method: p.method,
      amountCents: c(p.amountCents),
      status: p.status,
      refundedCents: c(p.refundedCents),
      chargedbackCents: c(p.chargedbackCents),
      netPaidCents: c(netPaidCents(p)),
    })),
    reconciliation: confirmed
      ? {
          totalCents: c(reconciliation.totalCents),
          paidCents: c(reconciliation.paidCents),
          processingCents: c(reconciliation.processingCents),
          assignedUnpaidCents: c(reconciliation.assignedUnpaidCents),
          unassignedCents: c(reconciliation.unassignedCents),
          excessCents: c(reconciliation.excessCents),
          refundDueCents: c(reconciliation.refundDueCents),
        }
      : null,
  };
}

export type BillView = Awaited<ReturnType<typeof billView>>;
