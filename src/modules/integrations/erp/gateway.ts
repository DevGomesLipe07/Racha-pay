// ERP Gateway — aplica o contrato canônico ao Core (03 § Contrato canônico; D2).
//   sem conta            → CREATED (devolve o link da mesa)
//   rascunho             → sincroniza itens/ajustes (UPDATED) ou nada muda (UNCHANGED)
//   divisão confirmada   → só acréscimo vira complemento confirmado (COMPLEMENTED);
//                          alterar/remover item confirmado ou mudar ajustes → ERP_DIVERGENCE + caso CBR

import { conflict, notFound, unprocessable } from '../../../app/errors.ts';
import type { PoolClient } from '../../../infra/db/pool.ts';
import { appendLedger } from '../../ledger/ledger-repo.ts';
import { openCase } from '../../payments/service.ts';
import type { ServiceContext } from '../../service-context.ts';
import { loadBill, type BillRow } from '../../shared-bills/repo.ts';
import * as bills from '../../shared-bills/service.ts';
import type { CanonicalAck, CanonicalSync } from './adapter.ts';

export type SyncStatus = 'CREATED' | 'UNCHANGED' | 'UPDATED' | 'COMPLEMENTED' | 'DIVERGENCE';

export interface SyncResult {
  status: SyncStatus;
  billId: string;
  shareToken?: string;
  splitVersion?: number;
  caseId?: string;
  divergence?: { itemRef?: string; reason: string }[];
}

interface ItemRow {
  id: string;
  external_ref: string | null;
  description: string;
  unit_price_cents: bigint;
  quantity: number;
  confirmed_version: number | null;
}

async function establishmentId(client: PoolClient, externalId: string | undefined): Promise<string | null> {
  if (!externalId) return null;
  const { rows } = await client.query<{ id: string }>('SELECT id FROM establishments WHERE external_id = $1', [externalId]);
  const row = rows[0];
  if (!row) throw unprocessable('ESTABLISHMENT_NOT_FOUND', 'estabelecimento não cadastrado', { establishmentExternalId: externalId });
  return row.id;
}

async function billByReference(client: PoolClient, externalReference: string): Promise<BillRow | undefined> {
  const { rows } = await client.query<{ id: string }>('SELECT id FROM bills WHERE external_reference = $1', [externalReference]);
  const id = rows[0]?.id;
  return id ? loadBill(client, id, { forUpdate: true }) : undefined;
}

const sameItem = (row: ItemRow, it: CanonicalSync['items'][number]) =>
  row.unit_price_cents === BigInt(it.unitPriceCents) && row.quantity === it.quantity && row.description === it.description;

export async function syncFromErp(
  client: PoolClient,
  ctx: ServiceContext,
  provider: string,
  c: CanonicalSync,
  opts: { allowComplement: boolean },
): Promise<SyncResult> {
  const estId = await establishmentId(client, c.establishmentExternalId);
  const existing = await billByReference(client, c.externalReference);

  if (!existing) {
    const billId = bills.newBillId();
    const created = await bills.createBill(client, ctx, billId, {
      kind: c.kind,
      title: c.title ?? (c.tableLabel ? `Mesa ${c.tableLabel}` : c.externalReference),
      collectionModel: 'MERCHANT_COLLECTS',
      ...(c.participants ? { participantNames: c.participants } : {}),
      ...(c.tableLabel ? { tableLabel: c.tableLabel } : {}),
      externalReference: c.externalReference,
      ...(estId ? { establishmentId: estId } : {}),
      erpProvider: provider,
    });
    for (const it of c.items) {
      await bills.addItem(client, ctx, billId, { description: it.description, unitPriceCents: BigInt(it.unitPriceCents), quantity: it.quantity, externalRef: it.externalRef });
    }
    await bills.updateBill(client, ctx, billId, {
      discountCents: BigInt(c.discountCents),
      tipCents: BigInt(c.tipCents),
      ...(c.serviceBp !== undefined ? { serviceBp: c.serviceBp } : {}),
    });
    return { status: 'CREATED', billId, shareToken: created.shareToken };
  }

  const bill = existing;
  if (bill.state === 'CANCELLED') throw conflict('BILL_CANCELLED', 'conta cancelada');
  const { rows: items } = await client.query<ItemRow>(
    'SELECT id, external_ref, description, unit_price_cents, quantity, confirmed_version FROM items WHERE bill_id = $1',
    [bill.id],
  );
  const byRef = new Map(items.filter((i) => i.external_ref).map((i) => [i.external_ref as string, i]));
  const incoming = new Map(c.items.map((i) => [i.externalRef, i]));
  const adjustmentsChanged =
    bill.discount_cents !== BigInt(c.discountCents) || bill.tip_cents !== BigInt(c.tipCents) || (c.serviceBp !== undefined && bill.service_bp !== c.serviceBp);

  // Divergência: algo já confirmado mudou ou sumiu (02 § D2 — só acréscimo vira complemento).
  if (bill.active_split_version !== null) {
    const divergence: { itemRef?: string; reason: string }[] = [];
    for (const row of items.filter((i) => i.confirmed_version !== null)) {
      const it = row.external_ref ? incoming.get(row.external_ref) : undefined;
      if (!row.external_ref) divergence.push({ reason: `item confirmado sem referência do ERP: ${row.description}` });
      else if (!it) divergence.push({ itemRef: row.external_ref, reason: 'item confirmado removido pelo ERP' });
      else if (!sameItem(row, it)) divergence.push({ itemRef: row.external_ref, reason: 'item confirmado alterado pelo ERP' });
    }
    if (adjustmentsChanged) divergence.push({ reason: 'desconto, serviço ou gorjeta alterados depois da divisão confirmada' });
    if (divergence.length > 0) {
      const caseId = await openCase(client, ctx, bill.id, 'ERP_DIVERGENCE', {
        features: ['kind:ERP_DIVERGENCE', `erp:${provider}`, `segment:${bill.kind}`, ...divergence.map((d) => `reason:${d.reason}`)],
        evidence: { externalReference: c.externalReference, divergence, splitVersion: bill.active_split_version },
      });
      return { status: 'DIVERGENCE', billId: bill.id, caseId, divergence };
    }
  } else if (adjustmentsChanged) {
    await bills.updateBill(client, ctx, bill.id, {
      discountCents: BigInt(c.discountCents),
      tipCents: BigInt(c.tipCents),
      ...(c.serviceBp !== undefined ? { serviceBp: c.serviceBp } : {}),
    });
  }

  // Itens ainda não confirmados: sincroniza (mantém marcações de quem consumiu quando o item não mudou).
  let changed = adjustmentsChanged;
  for (const row of items.filter((i) => i.confirmed_version === null && i.external_ref)) {
    const it = incoming.get(row.external_ref as string);
    if (!it) {
      await bills.removeItem(client, ctx, bill.id, row.id);
      changed = true;
    } else if (!sameItem(row, it)) {
      await client.query('UPDATE items SET description = $3, unit_price_cents = $4, quantity = $5 WHERE bill_id = $1 AND id = $2', [
        bill.id,
        row.id,
        it.description,
        it.unitPriceCents,
        it.quantity,
      ]);
      changed = true;
    }
  }
  const additions = c.items.filter((it) => !byRef.has(it.externalRef));
  for (const it of additions) {
    await bills.addItem(client, ctx, bill.id, { description: it.description, unitPriceCents: BigInt(it.unitPriceCents), quantity: it.quantity, externalRef: it.externalRef });
    changed = true;
  }

  if (bill.active_split_version !== null && changed) {
    if (!opts.allowComplement) throw conflict('COMPLEMENT_NOT_ALLOWED', 'a credencial não pode confirmar o complemento da divisão');
    const fresh = await loadBill(client, bill.id, { forUpdate: true });
    const plan = await bills.planSplit(client, ctx, fresh as BillRow);
    const { version } = await bills.confirmSplit(client, ctx, bill.id, plan.totals.totalCents);
    return { status: 'COMPLEMENTED', billId: bill.id, splitVersion: version };
  }
  return { status: changed ? 'UPDATED' : 'UNCHANGED', billId: bill.id };
}

export async function ackFromErp(client: PoolClient, ctx: ServiceContext, provider: string, ack: CanonicalAck): Promise<{ billId: string }> {
  const bill = await billByReference(client, ack.externalReference);
  if (!bill) throw notFound('conta');
  await appendLedger(client, ctx.tenantId, {
    billId: bill.id,
    type: 'ERP_ACKNOWLEDGED',
    payload: { provider, event: ack.event, erpDocument: ack.erpDocument },
    actor: ctx.actor,
    correlationId: ctx.correlationId,
    occurredAt: ctx.now.toISOString(),
  });
  return { billId: bill.id };
}
