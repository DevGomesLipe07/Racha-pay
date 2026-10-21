// Worker interno (sem fila externa — Guia §12): expira pagamentos pendentes vencidos.
// Cada pagamento é processado no escopo da própria conta; falha em um não para os outros.

import type { Clock } from '../infra/clock.ts';
import type { Pool } from '../infra/db/pool.ts';
import { withoutScope, withScope } from '../infra/db/tx.ts';
import type { Logger } from '../infra/log.ts';
import { applyEvent } from '../modules/payments/service.ts';

export async function expireDuePayments(pool: Pool, clock: Clock, logger: Logger, limit = 200): Promise<{ expired: number; failed: number }> {
  const now = clock.now();
  const { rows } = await withoutScope(pool, (c) =>
    c.query<{ tenant_id: string; bill_id: string; payment_id: string }>('SELECT * FROM rp_due_expirations($1, $2)', [now, limit]),
  );
  let expired = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await withScope(pool, { kind: 'bill', tenantId: r.tenant_id, billId: r.bill_id }, (client) =>
        applyEvent(
          client,
          { tenantId: r.tenant_id, actor: { type: 'SYSTEM', id: 'worker:expiry' }, correlationId: `expiry-${r.payment_id}`, now },
          r.bill_id,
          r.payment_id,
          { eventId: `expiry:${r.payment_id}`, kind: 'EXPIRED' },
          { origin: 'worker:expiry' },
        ),
      );
      expired++;
    } catch (error) {
      failed++;
      logger.error('expiry_failed', { paymentId: r.payment_id, message: (error as Error).message });
    }
  }
  return { expired, failed };
}

export function startWorker(deps: { pool: Pool; clock: Clock; logger: Logger }, intervalMs = 15_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    expireDuePayments(deps.pool, deps.clock, deps.logger)
      .then((r) => {
        if (r.expired || r.failed) deps.logger.info('expiry_cycle', r);
      })
      .catch((e: unknown) => deps.logger.error('worker_cycle_failed', { message: (e as Error).message }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
