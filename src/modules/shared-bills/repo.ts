// Leitura do agregado SharedBill. Sempre dentro de uma transação com escopo (RLS).

import type { PoolClient } from '../../infra/db/pool.ts';
import type { BillState } from '../reconciliation/reconcile.ts';
import type { SplitMode } from '../split/engine.ts';

export const BILL_KINDS = ['RESTAURANT', 'TRANSPORT', 'TRAVEL', 'MARKET', 'EVENT', 'GIFT', 'FUEL', 'ACCOMMODATION', 'OTHER'] as const;
export type BillKind = (typeof BILL_KINDS)[number];
export const COLLECTION_MODELS = ['ORGANIZER_COLLECTS', 'MERCHANT_COLLECTS'] as const;
export type CollectionModel = (typeof COLLECTION_MODELS)[number];

export interface BillRow {
  id: string;
  tenant_id: string;
  kind: BillKind;
  title: string;
  currency: string;
  collection_model: CollectionModel;
  state: BillState;
  split_mode: SplitMode;
  discount_cents: bigint;
  service_bp: number;
  tip_cents: bigint;
  active_split_version: number | null;
  table_label: string | null;
  external_reference: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface ParticipantRow {
  id: string;
  name: string;
  position: number;
  is_organizer: boolean;
  percent_bp: number | null;
  manual_cents: bigint | null;
}

export interface ItemRow {
  id: string;
  description: string;
  unit_price_cents: bigint;
  quantity: number;
  external_ref: string | null;
  confirmed_version: number | null;
  position: number;
}

export interface AssigneeRow {
  item_id: string;
  participant_id: string;
  weight: number;
}

export interface AllocationRow {
  participant_id: string;
  items_cents: bigint;
  discount_cents: bigint;
  service_cents: bigint;
  tip_cents: bigint;
  total_cents: bigint;
}

export interface SplitVersionRow {
  version: number;
  kind: 'CONFIRMED' | 'COMPLEMENT';
  mode: SplitMode;
  subtotal_cents: bigint;
  discount_cents: bigint;
  service_bp: number;
  service_cents: bigint;
  tip_cents: bigint;
  total_cents: bigint;
  rules: unknown;
  created_at: Date;
}

export interface BillAggregate {
  bill: BillRow;
  participants: ParticipantRow[];
  items: ItemRow[];
  assignees: AssigneeRow[];
}

export async function loadBill(client: PoolClient, billId: string, opts: { forUpdate?: boolean } = {}): Promise<BillRow | undefined> {
  const { rows } = await client.query<BillRow>(`SELECT * FROM bills WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`, [billId]);
  return rows[0];
}

export async function loadAggregate(client: PoolClient, bill: BillRow): Promise<BillAggregate> {
  // Um client pg executa uma consulta por vez: leituras em sequência na mesma transação.
  const participants = await client.query<ParticipantRow>(
    'SELECT id, name, position, is_organizer, percent_bp, manual_cents FROM participants WHERE bill_id = $1 ORDER BY position',
    [bill.id],
  );
  const items = await client.query<ItemRow>(
    'SELECT id, description, unit_price_cents, quantity, external_ref, confirmed_version, position FROM items WHERE bill_id = $1 ORDER BY position',
    [bill.id],
  );
  const assignees = await client.query<AssigneeRow>('SELECT item_id, participant_id, weight FROM item_assignees WHERE bill_id = $1', [bill.id]);
  return { bill, participants: participants.rows, items: items.rows, assignees: assignees.rows };
}

export async function loadAllocations(client: PoolClient, billId: string, version: number): Promise<AllocationRow[]> {
  const { rows } = await client.query<AllocationRow>(
    `SELECT participant_id, items_cents, discount_cents, service_cents, tip_cents, total_cents
       FROM split_allocations WHERE bill_id = $1 AND version = $2`,
    [billId, version],
  );
  return rows;
}

export async function loadSplitVersion(client: PoolClient, billId: string, version: number): Promise<SplitVersionRow | undefined> {
  const { rows } = await client.query<SplitVersionRow>(
    `SELECT version, kind, mode, subtotal_cents, discount_cents, service_bp, service_cents, tip_cents, total_cents, rules, created_at
       FROM split_versions WHERE bill_id = $1 AND version = $2`,
    [billId, version],
  );
  return rows[0];
}

export async function nextSplitVersion(client: PoolClient, billId: string): Promise<number> {
  const { rows } = await client.query<{ v: number }>('SELECT COALESCE(MAX(version), 0)::int + 1 AS v FROM split_versions WHERE bill_id = $1', [billId]);
  return (rows[0] as { v: number }).v;
}
