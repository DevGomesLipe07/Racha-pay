// Outbox transacional alimentado pelo ledger: todo evento financeiro relevante vira evento de webhook
// na MESMA transação (não há como gravar o ledger e perder o aviso, nem avisar sem gravar).

import type { PoolClient } from '../../../infra/db/pool.ts';
import type { LedgerEntry } from '../../ledger/chain.ts';

export const WEBHOOK_EVENT_TYPES = [
  'bill.created',
  'split.confirmed',
  'payment.created',
  'payment.confirmed',
  'payment.failed',
  'payment.refunded',
  'payment.chargedback',
  'bill.partially_paid',
  'bill.settled',
  'bill.reopened',
  'bill.cancelled',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_PAYLOAD_VERSION = '2026-10-01';

/** Ledger → tipo de webhook (undefined = não gera aviso). */
export function webhookTypeFor(entry: Pick<LedgerEntry, 'type' | 'payload'>): WebhookEventType | undefined {
  switch (entry.type) {
    case 'BILL_CREATED':
      return 'bill.created';
    case 'SPLIT_CONFIRMED':
    case 'SPLIT_COMPLEMENTED':
      return 'split.confirmed';
    case 'PAYMENT_CREATED':
      return 'payment.created';
    case 'PAYMENT_CONFIRMED':
      return 'payment.confirmed';
    case 'PAYMENT_FAILED':
    case 'PAYMENT_EXPIRED':
    case 'PAYMENT_REJECTED':
      return 'payment.failed';
    case 'PAYMENT_REFUNDED':
      return 'payment.refunded';
    case 'PAYMENT_CHARGEDBACK':
      return 'payment.chargedback';
    case 'BILL_CANCELLED':
      return 'bill.cancelled';
    case 'BILL_STATE_CHANGED': {
      const to = (entry.payload as { to?: string }).to;
      if (to === 'PARTIALLY_PAID') return 'bill.partially_paid';
      if (to === 'SETTLED') return 'bill.settled';
      if (to === 'REOPENED') return 'bill.reopened';
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Converte bigint em número para o JSON do webhook (valores já validados ≤ R$ 1 bilhão). */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  return value;
}

export async function enqueueFromLedger(client: PoolClient, tenantId: string, entry: LedgerEntry): Promise<void> {
  const type = webhookTypeFor(entry);
  if (!type) return;
  const has = await client.query<{ has: boolean }>('SELECT rp_tenant_has_webhooks($1) AS has', [tenantId]);
  if (!has.rows[0]?.has) return;
  const bill = await client.query<{ external_reference: string | null; table_label: string | null; state: string }>(
    'SELECT external_reference, table_label, state FROM bills WHERE id = $1',
    [entry.billId],
  );
  const b = bill.rows[0];
  const data = {
    billId: entry.billId,
    externalReference: b?.external_reference ?? null,
    tableLabel: b?.table_label ?? null,
    billState: b?.state ?? null,
    ledgerSeq: entry.seq,
    ledgerHash: entry.entryHash,
    ...(jsonSafe(entry.payload) as Record<string, unknown>),
  };
  await client.query('INSERT INTO outbox_events (tenant_id, bill_id, type, payload, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [
    tenantId,
    entry.billId,
    type,
    JSON.stringify(data),
    entry.occurredAt,
  ]);
}
