// LGPD — anonimização (D21). Troca nomes e textos livres por rótulos neutros, revoga os links da conta e
// apaga respostas de idempotência guardadas (que podem conter nomes). Não toca no ledger: ele só tem ids,
// e a prova financeira continua verificável depois da anonimização.

import { conflict, notFound } from '../../app/errors.ts';
import type { Clock } from '../../infra/clock.ts';
import type { Pool, PoolClient } from '../../infra/db/pool.ts';
import { withoutScope, withScope } from '../../infra/db/tx.ts';
import type { Logger } from '../../infra/log.ts';
import { resolveKnowledge } from '../expert/library.ts';
import { loadBill } from '../shared-bills/repo.ts';

export interface AnonymizeResult {
  billId: string;
  participants: number;
  items: number;
  revokedTokens: number;
}

/** Anonimiza uma conta (o chamador já está no escopo dela e decidiu que pode). Idempotente. */
export async function anonymizeBill(client: PoolClient, billId: string, now: Date): Promise<AnonymizeResult> {
  const participants = await client.query(
    "UPDATE participants SET name = 'Participante ' || (position + 1) WHERE bill_id = $1",
    [billId],
  );
  const items = await client.query("UPDATE items SET description = 'Item ' || (position + 1) WHERE bill_id = $1", [billId]);
  await client.query(
    `UPDATE bills SET title = 'Conta anonimizada', table_label = NULL, pix_key = NULL, pix_key_type = NULL, pix_city = NULL,
            anonymized_at = COALESCE(anonymized_at, $2), updated_at = $2
      WHERE id = $1`,
    [billId, now],
  );
  await client.query('DELETE FROM idempotency_keys WHERE bill_id = $1', [billId]);
  const revoked = await client.query<{ n: number }>('SELECT rp_revoke_bill_tokens($1, $2) AS n', [billId, now]);
  return { billId, participants: participants.rowCount ?? 0, items: items.rowCount ?? 0, revokedTokens: revoked.rows[0]?.n ?? 0 };
}

/** Pedido do titular (organizador/estabelecimento): só sem pagamento em andamento. */
export async function anonymizeOnRequest(client: PoolClient, billId: string, now: Date): Promise<AnonymizeResult> {
  const bill = await loadBill(client, billId, { forUpdate: true });
  if (!bill) throw notFound('conta');
  const processing = await client.query(
    "SELECT 1 FROM payments WHERE bill_id = $1 AND status IN ('CREATED', 'PENDING', 'AUTHORIZED') LIMIT 1",
    [billId],
  );
  if ((processing.rowCount ?? 0) > 0) throw conflict('PAYMENT_IN_PROGRESS', 'há pagamento em andamento; conclua ou recuse antes de anonimizar');
  return anonymizeBill(client, billId, now);
}

/** Rotina periódica: passa por cada tenant, no escopo dele, e anonimiza o que venceu o prazo. */
export async function runRetention(pool: Pool, clock: Clock, logger: Logger, limitPerTenant = 500): Promise<{ anonymized: number; purgedKeys: number }> {
  const now = clock.now();
  const { rows: tenants } = await withoutScope(pool, (c) => c.query<{ tenant_id: string }>('SELECT * FROM rp_all_tenants()'));
  // Contadores de rate limit de janelas que já passaram não servem para nada.
  await pool.query('DELETE FROM rate_limit_hits WHERE window_start < $1', [new Date(now.getTime() - 2 * 3_600_000)]);
  let anonymized = 0;
  let purgedKeys = 0;
  for (const { tenant_id: tenantId } of tenants) {
    try {
      const done = await withScope(pool, { kind: 'tenant', tenantId }, async (client) => {
        const purged = await client.query('DELETE FROM idempotency_keys WHERE expires_at < $1', [now]);
        const rule = await resolveKnowledge(client, 'RETENTION.PERSONAL_DATA', { tenantId }, now);
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM bills
            WHERE anonymized_at IS NULL
              AND (   (state IN ('SETTLED', 'CANCELLED') AND updated_at < $1)
                   OR (state NOT IN ('SETTLED', 'CANCELLED') AND updated_at < $2
                       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.bill_id = bills.id AND p.status IN ('CREATED', 'PENDING', 'AUTHORIZED'))))
            ORDER BY updated_at LIMIT $3`,
          [new Date(now.getTime() - rule.content.terminalDays * 86_400_000), new Date(now.getTime() - rule.content.abandonedDays * 86_400_000), limitPerTenant],
        );
        for (const r of rows) await anonymizeBill(client, r.id, now);
        return { bills: rows.length, keys: purged.rowCount ?? 0 };
      });
      anonymized += done.bills;
      purgedKeys += done.keys;
    } catch (error) {
      logger.error('retention_failed', { tenantId, message: (error as Error).message });
    }
  }
  return { anonymized, purgedKeys };
}
