// Agregado SharedBill — regras de 02 § SharedBill e D1, D2, D5, D7, D8.
// Toda função recebe um client já em transação com escopo; operações que mexem em dinheiro
// travam a conta (SELECT … FOR UPDATE) antes de ler e gravar.

import { randomUUID } from 'node:crypto';
import { conflict, notFound, unprocessable } from '../../app/errors.ts';
import { newToken } from '../../infra/crypto/hash.ts';
import type { PoolClient } from '../../infra/db/pool.ts';
import { provenance, resolveKnowledge, type KnowledgeKey, type ResolvedKnowledge } from '../expert/library.ts';
import { appendLedger } from '../ledger/ledger-repo.ts';
import type { LedgerEntryDraft } from '../ledger/chain.ts';
import { refreshBillState } from '../reconciliation/service.ts';
import type { ServiceContext } from '../service-context.ts';
import { computeSplit, type SplitInput, type SplitMode, type SplitResult } from '../split/engine.ts';
import {
  loadAggregate,
  loadAllocations,
  loadBill,
  loadSplitVersion,
  nextSplitVersion,
  knowledgeContext,
  type BillAggregate,
  type BillKind,
  type BillRow,
  type CollectionModel,
} from './repo.ts';

const TERMINAL = new Set(['CANCELLED']);

function ledger(ctx: ServiceContext, billId: string, type: LedgerEntryDraft['type'], payload: LedgerEntryDraft['payload']): LedgerEntryDraft {
  return { billId, type, payload, actor: ctx.actor, correlationId: ctx.correlationId, occurredAt: ctx.now.toISOString() };
}

async function requireBill(client: PoolClient, billId: string, forUpdate = true): Promise<BillRow> {
  const bill = await loadBill(client, billId, { forUpdate });
  if (!bill) throw notFound('conta');
  return bill;
}

function requireNotTerminal(bill: BillRow): void {
  if (TERMINAL.has(bill.state)) throw conflict('BILL_CANCELLED', 'conta cancelada');
}

function requireDraft(bill: BillRow, what: string): void {
  if (bill.active_split_version !== null) {
    throw conflict('SPLIT_LOCKED', `${what} só em rascunho: a divisão já foi confirmada (destrave ou use complemento)`);
  }
  requireNotTerminal(bill);
}

/** Pagamentos ativos (em processamento) ou recebidos (já confirmados alguma vez). */
async function hasActiveOrReceivedPayments(client: PoolClient, billId: string): Promise<boolean> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payments
      WHERE bill_id = $1 AND status IN ('CREATED', 'PENDING', 'AUTHORIZED', 'CONFIRMED', 'REFUNDED', 'CHARGEDBACK')`,
    [billId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Criação

export interface CreateBillInput {
  kind: BillKind;
  title: string;
  collectionModel: CollectionModel;
  organizerName?: string;
  participantNames?: string[];
  tableLabel?: string;
  externalReference?: string;
  /** Estabelecimento do tenant (Business): regras de escopo ESTABLISHMENT passam a valer para a conta. */
  establishmentId?: string;
  erpProvider?: string;
}

export interface CreatedBill {
  billId: string;
  organizerToken?: string;
  shareToken: string;
}

/** O id da conta é gerado antes, para abrir a transação já no escopo dela (D9). */
export function newBillId(): string {
  return randomUUID();
}

export async function createBill(client: PoolClient, ctx: ServiceContext, billId: string, input: CreateBillInput): Promise<CreatedBill> {
  if (input.collectionModel === 'ORGANIZER_COLLECTS' && !input.organizerName) {
    throw unprocessable('ORGANIZER_REQUIRED', 'quem organiza precisa de um nome (ele já pagou e cobra os demais)');
  }
  if (input.establishmentId) {
    const est = await client.query('SELECT 1 FROM establishments WHERE id = $1', [input.establishmentId]);
    if (est.rowCount === 0) throw unprocessable('ESTABLISHMENT_NOT_FOUND', 'estabelecimento não cadastrado');
  }
  const service = await resolveKnowledge(
    client,
    'SERVICE_CHARGE.DEFAULT',
    knowledgeContext({ tenant_id: ctx.tenantId, kind: input.kind, establishment_id: input.establishmentId ?? null, erp_provider: input.erpProvider ?? null }),
    ctx.now,
  );
  await client.query(
    `INSERT INTO bills (id, tenant_id, kind, title, collection_model, service_bp, table_label, external_reference, establishment_id, erp_provider, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
    [
      billId,
      ctx.tenantId,
      input.kind,
      input.title,
      input.collectionModel,
      service.content.bp,
      input.tableLabel ?? null,
      input.externalReference ?? null,
      input.establishmentId ?? null,
      input.erpProvider ?? null,
      ctx.now,
    ],
  );
  const names = [...(input.organizerName ? [input.organizerName] : []), ...(input.participantNames ?? [])];
  for (const [position, name] of names.entries()) {
    await client.query(
      'INSERT INTO participants (tenant_id, bill_id, name, position, is_organizer) VALUES ($1, $2, $3, $4, $5)',
      [ctx.tenantId, billId, name, position, position === 0 && Boolean(input.organizerName)],
    );
  }
  const share = newToken('share');
  const tokens: CreatedBill = { billId, shareToken: share.token };
  await client.query("INSERT INTO bill_tokens (token_hash, tenant_id, bill_id, kind) VALUES ($1, $2, $3, 'SHARE')", [share.hash, ctx.tenantId, billId]);
  if (input.collectionModel === 'ORGANIZER_COLLECTS') {
    const organizer = newToken('organizer');
    await client.query("INSERT INTO bill_tokens (token_hash, tenant_id, bill_id, kind) VALUES ($1, $2, $3, 'ORGANIZER')", [
      organizer.hash,
      ctx.tenantId,
      billId,
    ]);
    tokens.organizerToken = organizer.token;
  }
  await appendLedger(
    client,
    ctx.tenantId,
    ledger(ctx, billId, 'BILL_CREATED', {
      kind: input.kind,
      collectionModel: input.collectionModel,
      serviceBp: service.content.bp,
      rules: [provenance(service)],
    }),
  );
  return tokens;
}

/** Emite um novo link de convidado (o token só existe em hash; o antigo continua válido). */
export async function issueShareToken(client: PoolClient, ctx: ServiceContext, billId: string): Promise<string> {
  const bill = await requireBill(client, billId);
  requireNotTerminal(bill);
  const share = newToken('share');
  await client.query("INSERT INTO bill_tokens (token_hash, tenant_id, bill_id, kind) VALUES ($1, $2, $3, 'SHARE')", [share.hash, ctx.tenantId, billId]);
  return share.token;
}

// ---------------------------------------------------------------------------
// Edição (rascunho)

export interface BillPatch {
  title?: string;
  splitMode?: SplitMode;
  discountCents?: bigint;
  serviceBp?: number;
  tipCents?: bigint;
}

export async function updateBill(client: PoolClient, ctx: ServiceContext, billId: string, patch: BillPatch): Promise<void> {
  const bill = await requireBill(client, billId);
  requireNotTerminal(bill);
  const money = patch.splitMode !== undefined || patch.discountCents !== undefined || patch.serviceBp !== undefined || patch.tipCents !== undefined;
  if (money) requireDraft(bill, 'alterar modo, desconto, serviço ou gorjeta');
  if (patch.serviceBp !== undefined) {
    const service = await resolveKnowledge(client, 'SERVICE_CHARGE.DEFAULT', knowledgeContext(bill), ctx.now);
    if (patch.serviceBp > service.content.maxBp) {
      throw unprocessable('SERVICE_BP_OUT_OF_RANGE', `serviço máximo: ${service.content.maxBp} bp`, { maxBp: service.content.maxBp });
    }
  }
  await client.query(
    `UPDATE bills SET title = COALESCE($2, title), split_mode = COALESCE($3, split_mode), discount_cents = COALESCE($4, discount_cents),
            service_bp = COALESCE($5, service_bp), tip_cents = COALESCE($6, tip_cents), updated_at = $7, row_version = row_version + 1
      WHERE id = $1`,
    [billId, patch.title ?? null, patch.splitMode ?? null, patch.discountCents ?? null, patch.serviceBp ?? null, patch.tipCents ?? null, ctx.now],
  );
}

export async function addParticipant(client: PoolClient, ctx: ServiceContext, billId: string, name: string): Promise<string> {
  const bill = await requireBill(client, billId);
  requireNotTerminal(bill);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO participants (tenant_id, bill_id, name, position)
     VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position) + 1, 0) FROM participants WHERE bill_id = $2))
     RETURNING id`,
    [ctx.tenantId, billId, name],
  );
  await touch(client, billId, ctx.now);
  return (rows[0] as { id: string }).id;
}

export interface ParticipantPatch {
  name?: string;
  percentBp?: number | null;
  manualCents?: bigint | null;
}

export async function updateParticipant(client: PoolClient, ctx: ServiceContext, billId: string, participantId: string, patch: ParticipantPatch): Promise<void> {
  const bill = await requireBill(client, billId);
  requireNotTerminal(bill);
  if (patch.percentBp !== undefined || patch.manualCents !== undefined) requireDraft(bill, 'alterar percentual ou valor manual');
  const sets: string[] = [];
  const params: unknown[] = [billId, participantId];
  if (patch.name !== undefined) sets.push(`name = $${params.push(patch.name)}`);
  if (patch.percentBp !== undefined) sets.push(`percent_bp = $${params.push(patch.percentBp)}`);
  if (patch.manualCents !== undefined) sets.push(`manual_cents = $${params.push(patch.manualCents)}`);
  if (sets.length === 0) return;
  const res = await client.query(`UPDATE participants SET ${sets.join(', ')} WHERE bill_id = $1 AND id = $2`, params);
  if (res.rowCount === 0) throw notFound('participante');
  await touch(client, billId, ctx.now);
}

/** D8 — só em rascunho, sem pagamentos; itens em que era o único marcado voltam a ser de todos. */
export async function removeParticipant(client: PoolClient, ctx: ServiceContext, billId: string, participantId: string): Promise<void> {
  const bill = await requireBill(client, billId);
  requireDraft(bill, 'remover participante');
  const { rows } = await client.query<{ is_organizer: boolean }>('SELECT is_organizer FROM participants WHERE bill_id = $1 AND id = $2', [
    billId,
    participantId,
  ]);
  const p = rows[0];
  if (!p) throw notFound('participante');
  if (p.is_organizer) throw conflict('ORGANIZER_REQUIRED', 'quem organiza não pode ser removido');
  const paid = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM payments WHERE participant_id = $1', [participantId]);
  if ((paid.rows[0]?.n ?? 0) > 0) throw conflict('PARTICIPANT_HAS_PAYMENTS', 'participante com pagamentos não pode ser removido');
  await client.query('DELETE FROM participants WHERE bill_id = $1 AND id = $2', [billId, participantId]);
  await touch(client, billId, ctx.now);
}

export interface ItemInput {
  description: string;
  unitPriceCents: bigint;
  quantity: number;
  externalRef?: string;
  assignees?: { participantId: string; weight?: number }[];
}

/** Em rascunho entra na divisão; com a divisão confirmada fica pendente de complemento (D2). */
export async function addItem(client: PoolClient, ctx: ServiceContext, billId: string, input: ItemInput): Promise<string> {
  const bill = await requireBill(client, billId);
  requireNotTerminal(bill);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO items (tenant_id, bill_id, description, unit_price_cents, quantity, external_ref, position)
     VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(MAX(position) + 1, 0) FROM items WHERE bill_id = $2))
     RETURNING id`,
    [ctx.tenantId, billId, input.description, input.unitPriceCents, input.quantity, input.externalRef ?? null],
  );
  const itemId = (rows[0] as { id: string }).id;
  if (input.assignees) await writeAssignees(client, ctx, billId, itemId, input.assignees);
  await touch(client, billId, ctx.now);
  return itemId;
}

export async function setItemAssignees(
  client: PoolClient,
  ctx: ServiceContext,
  billId: string,
  itemId: string,
  assignees: { participantId: string; weight?: number }[],
): Promise<void> {
  const bill = await requireBill(client, billId);
  requireNotTerminal(bill);
  await requireEditableItem(client, billId, itemId);
  await client.query('DELETE FROM item_assignees WHERE bill_id = $1 AND item_id = $2', [billId, itemId]);
  await writeAssignees(client, ctx, billId, itemId, assignees);
  await touch(client, billId, ctx.now);
}

export async function removeItem(client: PoolClient, ctx: ServiceContext, billId: string, itemId: string): Promise<void> {
  const bill = await requireBill(client, billId);
  requireNotTerminal(bill);
  await requireEditableItem(client, billId, itemId);
  await client.query('DELETE FROM items WHERE bill_id = $1 AND id = $2', [billId, itemId]);
  await touch(client, billId, ctx.now);
}

async function requireEditableItem(client: PoolClient, billId: string, itemId: string): Promise<void> {
  const { rows } = await client.query<{ confirmed_version: number | null }>('SELECT confirmed_version FROM items WHERE bill_id = $1 AND id = $2', [
    billId,
    itemId,
  ]);
  const item = rows[0];
  if (!item) throw notFound('item');
  if (item.confirmed_version !== null) {
    throw conflict('ITEM_CONFIRMED', 'item já entrou numa divisão confirmada: não pode ser alterado nem removido');
  }
}

async function writeAssignees(
  client: PoolClient,
  ctx: ServiceContext,
  billId: string,
  itemId: string,
  assignees: { participantId: string; weight?: number }[],
): Promise<void> {
  const seen = new Set<string>();
  for (const a of assignees) {
    if (seen.has(a.participantId)) throw unprocessable('DUPLICATE_ASSIGNEE', 'participante marcado duas vezes no mesmo item');
    seen.add(a.participantId);
    const exists = await client.query('SELECT 1 FROM participants WHERE bill_id = $1 AND id = $2', [billId, a.participantId]);
    if (exists.rowCount === 0) throw unprocessable('UNKNOWN_PARTICIPANT', 'item marcado para participante inexistente', { participantId: a.participantId });
    await client.query('INSERT INTO item_assignees (tenant_id, bill_id, item_id, participant_id, weight) VALUES ($1, $2, $3, $4, $5)', [
      ctx.tenantId,
      billId,
      itemId,
      a.participantId,
      a.weight ?? 1,
    ]);
  }
}

async function touch(client: PoolClient, billId: string, now: Date): Promise<void> {
  await client.query('UPDATE bills SET updated_at = $2, row_version = row_version + 1 WHERE id = $1', [billId, now]);
}

// ---------------------------------------------------------------------------
// Prévia e confirmação

export interface SplitPlan {
  kind: 'FULL' | 'COMPLEMENT';
  /** Divisão desta etapa (conta inteira, ou só o acréscimo no complemento). */
  step: SplitResult;
  /** Devido acumulado por participante depois de confirmar. */
  cumulative: { participantId: string; itemsCents: bigint; discountCents: bigint; serviceCents: bigint; tipCents: bigint; totalCents: bigint }[];
  totals: { subtotalCents: bigint; discountCents: bigint; serviceCents: bigint; tipCents: bigint; totalCents: bigint };
  serviceBp: number;
  pendingItemIds: string[];
  rules: ReturnType<typeof provenance>[];
}

async function splitRules(client: PoolClient, ctx: ServiceContext, bill: BillRow) {
  const keys: KnowledgeKey[] = ['SERVICE_CHARGE.DEFAULT', 'DISCOUNT.ALLOCATION', 'TIP.ALLOCATION', 'ROUNDING.ALLOCATION'];
  const resolved: ResolvedKnowledge<KnowledgeKey>[] = [];
  for (const k of keys) resolved.push(await resolveKnowledge(client, k, knowledgeContext(bill), ctx.now));
  const service = resolved[0] as ResolvedKnowledge<'SERVICE_CHARGE.DEFAULT'>;
  return { maxServiceBp: service.content.maxBp, rules: resolved.map(provenance) };
}

function engineInput(agg: BillAggregate, items: BillAggregate['items'], over: Partial<SplitInput>, maxServiceBp: number): SplitInput {
  const { bill, participants, assignees } = agg;
  return {
    mode: bill.split_mode,
    participants: participants.map((p) => ({ id: p.id })),
    items: items.map((it) => ({
      id: it.id,
      unitPriceCents: it.unit_price_cents,
      quantity: it.quantity,
      assignees: assignees.filter((a) => a.item_id === it.id).map((a) => ({ participantId: a.participant_id, weight: a.weight })),
    })),
    discountCents: bill.discount_cents,
    serviceBp: bill.service_bp,
    tipCents: bill.tip_cents,
    percentBp: Object.fromEntries(participants.map((p) => [p.id, p.percent_bp ?? 0])),
    manualCents: Object.fromEntries(participants.map((p) => [p.id, p.manual_cents ?? 0n])),
    limits: { maxServiceBp },
    ...over,
  };
}

export async function planSplit(client: PoolClient, ctx: ServiceContext, bill: BillRow): Promise<SplitPlan> {
  requireNotTerminal(bill);
  const agg = await loadAggregate(client, bill);
  const { maxServiceBp, rules } = await splitRules(client, ctx, bill);

  if (bill.active_split_version === null) {
    const step = computeSplit(engineInput(agg, agg.items, {}, maxServiceBp));
    return {
      kind: 'FULL',
      step,
      cumulative: step.shares,
      totals: step,
      serviceBp: bill.service_bp,
      pendingItemIds: agg.items.map((i) => i.id),
      rules,
    };
  }

  // D2 — complemento: só os itens novos, com a mesma regra de serviço; desconto e gorjeta não mudam.
  const pending = agg.items.filter((i) => i.confirmed_version === null);
  if (pending.length === 0) throw conflict('NOTHING_TO_CONFIRM', 'não há itens novos para complementar a divisão');
  const mode: SplitMode = bill.split_mode === 'MANUAL' ? 'BY_ITEM' : bill.split_mode;
  const step = computeSplit(engineInput(agg, pending, { mode, discountCents: 0n, tipCents: 0n }, maxServiceBp));
  const previous = await loadAllocations(client, bill.id, bill.active_split_version);
  const previousVersion = await loadSplitVersion(client, bill.id, bill.active_split_version);
  if (!previousVersion) throw new Error('versão ativa ausente');
  const prevBy = new Map(previous.map((a) => [a.participant_id, a]));
  const cumulative = step.shares.map((s) => {
    const p = prevBy.get(s.participantId);
    return {
      participantId: s.participantId,
      itemsCents: s.itemsCents + (p?.items_cents ?? 0n),
      discountCents: s.discountCents + (p?.discount_cents ?? 0n),
      serviceCents: s.serviceCents + (p?.service_cents ?? 0n),
      tipCents: s.tipCents + (p?.tip_cents ?? 0n),
      totalCents: s.totalCents + (p?.total_cents ?? 0n),
    };
  });
  return {
    kind: 'COMPLEMENT',
    step,
    cumulative,
    totals: {
      subtotalCents: previousVersion.subtotal_cents + step.subtotalCents,
      discountCents: previousVersion.discount_cents,
      serviceCents: previousVersion.service_cents + step.serviceCents,
      tipCents: previousVersion.tip_cents,
      totalCents: previousVersion.total_cents + step.totalCents,
    },
    serviceBp: bill.service_bp,
    pendingItemIds: pending.map((i) => i.id),
    rules,
  };
}

export async function previewSplit(client: PoolClient, ctx: ServiceContext, billId: string): Promise<SplitPlan> {
  const bill = await requireBill(client, billId, false);
  return planSplit(client, ctx, bill);
}

/**
 * Confirma a divisão (ou o complemento). O cliente manda o total que viu na prévia;
 * se a conta mudou nesse meio-tempo, recusa com STALE_PREVIEW.
 */
export async function confirmSplit(
  client: PoolClient,
  ctx: ServiceContext,
  billId: string,
  expectedTotalCents: bigint,
): Promise<{ version: number; plan: SplitPlan }> {
  const bill = await requireBill(client, billId);
  const plan = await planSplit(client, ctx, bill);
  if (plan.totals.totalCents !== expectedTotalCents) {
    throw conflict('STALE_PREVIEW', 'a conta mudou depois da prévia; confira de novo', { totalCents: Number(plan.totals.totalCents) });
  }
  // D1 — tudo atribuído: a soma das partes fecha o total (o engine garante; conferimos antes de gravar).
  const assigned = plan.cumulative.reduce((s, c) => s + c.totalCents, 0n);
  if (assigned !== plan.totals.totalCents) throw new Error('invariante D1 violada: partes não somam o total');

  const version = await nextSplitVersion(client, bill.id);
  const t = plan.totals;
  await client.query(
    `INSERT INTO split_versions (tenant_id, bill_id, version, kind, mode, subtotal_cents, discount_cents, service_bp, service_cents, tip_cents, total_cents, rules, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
    [
      ctx.tenantId,
      bill.id,
      version,
      plan.kind === 'FULL' ? 'CONFIRMED' : 'COMPLEMENT',
      plan.step.mode,
      t.subtotalCents,
      t.discountCents,
      plan.serviceBp,
      t.serviceCents,
      t.tipCents,
      t.totalCents,
      JSON.stringify(plan.rules),
      ctx.now,
    ],
  );
  for (const c of plan.cumulative) {
    await client.query(
      `INSERT INTO split_allocations (tenant_id, bill_id, version, participant_id, items_cents, discount_cents, service_cents, tip_cents, total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ctx.tenantId, bill.id, version, c.participantId, c.itemsCents, c.discountCents, c.serviceCents, c.tipCents, c.totalCents],
    );
  }
  await client.query('UPDATE items SET confirmed_version = $3 WHERE bill_id = $1 AND id = ANY($2::uuid[])', [bill.id, plan.pendingItemIds, version]);
  await client.query('UPDATE bills SET active_split_version = $2, updated_at = $3, row_version = row_version + 1 WHERE id = $1', [
    bill.id,
    version,
    ctx.now,
  ]);

  await appendLedger(
    client,
    ctx.tenantId,
    ledger(ctx, bill.id, plan.kind === 'FULL' ? 'SPLIT_CONFIRMED' : 'SPLIT_COMPLEMENTED', {
      version,
      mode: plan.step.mode,
      totalCents: t.totalCents,
      allocations: plan.cumulative.map((c) => ({ participantId: c.participantId, dueCents: c.totalCents })),
      rules: plan.rules,
    }),
  );
  if (bill.collection_model === 'ORGANIZER_COLLECTS') {
    const { rows } = await client.query<{ id: string }>('SELECT id FROM participants WHERE bill_id = $1 AND is_organizer', [bill.id]);
    const organizerId = rows[0]?.id;
    const share = plan.cumulative.find((c) => c.participantId === organizerId);
    if (organizerId && share) {
      await appendLedger(
        client,
        ctx.tenantId,
        ledger(ctx, bill.id, 'ORGANIZER_SHARE_SELF_SETTLED', { participantId: organizerId, amountCents: share.totalCents, version }),
      );
    }
  }
  const fresh = await requireBill(client, bill.id);
  await refreshBillState(client, ctx, fresh);
  return { version, plan };
}

export async function unlockSplit(client: PoolClient, ctx: ServiceContext, billId: string): Promise<void> {
  const bill = await requireBill(client, billId);
  requireNotTerminal(bill);
  if (bill.active_split_version === null) throw conflict('SPLIT_NOT_CONFIRMED', 'a divisão ainda não foi confirmada');
  if (await hasActiveOrReceivedPayments(client, billId)) {
    throw conflict('HAS_PAYMENTS', 'há pagamentos ativos ou recebidos: acréscimos entram como complemento');
  }
  await client.query('UPDATE items SET confirmed_version = NULL WHERE bill_id = $1', [billId]);
  await client.query('UPDATE bills SET active_split_version = NULL, updated_at = $2, row_version = row_version + 1 WHERE id = $1', [billId, ctx.now]);
  await appendLedger(client, ctx.tenantId, ledger(ctx, billId, 'SPLIT_UNLOCKED', { fromVersion: bill.active_split_version }));
  await refreshBillState(client, ctx, await requireBill(client, billId));
}

export async function cancelBill(client: PoolClient, ctx: ServiceContext, billId: string, reason: string): Promise<void> {
  const bill = await requireBill(client, billId);
  requireNotTerminal(bill);
  if (await hasActiveOrReceivedPayments(client, billId)) throw conflict('HAS_PAYMENTS', 'há pagamentos ativos ou recebidos');
  await client.query('UPDATE bills SET cancelled_at = $2 WHERE id = $1', [billId, ctx.now]);
  await appendLedger(client, ctx.tenantId, ledger(ctx, billId, 'BILL_CANCELLED', { reason }));
  await refreshBillState(client, ctx, bill, { cancelled: true });
}
