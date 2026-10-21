// Persistência do ledger. O chamador já deve ter a conta travada (SELECT … FOR UPDATE) na transação.

import { canonicalJson } from '../../infra/crypto/canonical-json.ts';
import type { PoolClient } from '../../infra/db/pool.ts';
import { chainNext, type LedgerEntry, type LedgerEntryDraft } from './chain.ts';

interface LedgerRow {
  bill_id: string;
  seq: number;
  type: LedgerEntry['type'];
  payload: LedgerEntry['payload'];
  actor_type: LedgerEntry['actor']['type'];
  actor_id: string;
  correlation_id: string;
  occurred_at: string;
  prev_hash: string;
  entry_hash: string;
}

function fromRow(r: LedgerRow): LedgerEntry {
  return {
    billId: r.bill_id,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    actor: { type: r.actor_type, id: r.actor_id },
    correlationId: r.correlation_id,
    occurredAt: r.occurred_at,
    prevHash: r.prev_hash,
    entryHash: r.entry_hash,
  };
}

export async function appendLedger(client: PoolClient, tenantId: string, draft: LedgerEntryDraft): Promise<LedgerEntry> {
  const { rows } = await client.query<{ seq: number; entry_hash: string }>(
    'SELECT seq, entry_hash FROM ledger_entries WHERE bill_id = $1 ORDER BY seq DESC LIMIT 1',
    [draft.billId],
  );
  const last = rows[0];
  const entry = chainNext(last ? { seq: last.seq, entryHash: last.entry_hash } : undefined, draft);
  await client.query(
    `INSERT INTO ledger_entries (tenant_id, bill_id, seq, type, payload, actor_type, actor_id, correlation_id, occurred_at, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
    [
      tenantId,
      entry.billId,
      entry.seq,
      entry.type,
      canonicalJson(entry.payload),
      entry.actor.type,
      entry.actor.id,
      entry.correlationId,
      entry.occurredAt,
      entry.prevHash,
      entry.entryHash,
    ],
  );
  return entry;
}

export async function readLedger(client: PoolClient, billId: string): Promise<LedgerEntry[]> {
  const { rows } = await client.query<LedgerRow>(
    `SELECT bill_id, seq, type, payload, actor_type, actor_id, correlation_id, occurred_at, prev_hash, entry_hash
       FROM ledger_entries WHERE bill_id = $1 ORDER BY seq`,
    [billId],
  );
  return rows.map(fromRow);
}
