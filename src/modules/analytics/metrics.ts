// North Star: rachas completamente quitados por mês (02 § North Star), com taxa de conclusão,
// participantes médios, mediana até quitação, volume e exceções. Mês no fuso America/Sao_Paulo (D15).
// Volume separado por natureza: MANUAL é DECLARADO (o RachaPay não viu o dinheiro); SANDBOX é TESTE.
// Tudo calculado a partir do ledger e das tabelas da conta, no escopo do tenant (RLS).

import type { PoolClient } from '../../infra/db/pool.ts';

export interface MonthMetrics {
  month: string;
  timezone: 'America/Sao_Paulo';
  settledBills: number;
  confirmedBills: number;
  completionRate: number | null;
  averageParticipants: number | null;
  medianMinutesToSettle: number | null;
  volume: { declaredManualCents: number; sandboxTestCents: number; providerCents: number };
  exceptions: Record<string, number>;
}

export async function monthMetrics(client: PoolClient, month: string): Promise<MonthMetrics> {
  const params = [month];
  // Primeira confirmação e primeira quitação de cada conta, no fuso de São Paulo.
  const { rows } = await client.query<{
    confirmed: number;
    settled: number;
    settled_of_confirmed: number;
    avg_participants: string | null;
    median_minutes: string | null;
  }>(
    `WITH firsts AS (
       SELECT bill_id,
              MIN(CASE WHEN type = 'SPLIT_CONFIRMED' THEN occurred_at::timestamptz END) AS confirmed_at,
              MIN(CASE WHEN type = 'BILL_STATE_CHANGED' AND payload->>'to' = 'SETTLED' THEN occurred_at::timestamptz END) AS settled_at
         FROM ledger_entries GROUP BY bill_id
     ),
     m AS (SELECT to_timestamp($1 || '-01', 'YYYY-MM-DD')::timestamp AS start)
     SELECT
       count(*) FILTER (WHERE date_trunc('month', f.confirmed_at AT TIME ZONE 'America/Sao_Paulo') = m.start)::int AS confirmed,
       count(*) FILTER (WHERE date_trunc('month', f.settled_at AT TIME ZONE 'America/Sao_Paulo') = m.start)::int AS settled,
       count(*) FILTER (WHERE date_trunc('month', f.confirmed_at AT TIME ZONE 'America/Sao_Paulo') = m.start AND f.settled_at IS NOT NULL)::int AS settled_of_confirmed,
       avg((SELECT count(*) FROM participants p WHERE p.bill_id = f.bill_id))
         FILTER (WHERE date_trunc('month', f.confirmed_at AT TIME ZONE 'America/Sao_Paulo') = m.start) AS avg_participants,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM f.settled_at - f.confirmed_at) / 60)
         FILTER (WHERE date_trunc('month', f.settled_at AT TIME ZONE 'America/Sao_Paulo') = m.start AND f.confirmed_at IS NOT NULL) AS median_minutes
     FROM firsts f, m`,
    params,
  );
  const r = rows[0] as (typeof rows)[number];

  const volume = await client.query<{ method_class: string; cents: string }>(
    `SELECT CASE WHEN p.method = 'MANUAL' THEN 'manual' WHEN p.method = 'SANDBOX' THEN 'sandbox' ELSE 'provider' END AS method_class,
            COALESCE(SUM(CASE WHEN l.type = 'PAYMENT_CONFIRMED' THEN (l.payload->>'amountCents')::bigint
                              ELSE -(l.payload->>'amountCents')::bigint END), 0)::bigint AS cents
       FROM ledger_entries l
       JOIN payments p ON p.id = (l.payload->>'paymentId')::uuid
      WHERE l.type IN ('PAYMENT_CONFIRMED', 'PAYMENT_REFUNDED', 'PAYMENT_CHARGEDBACK')
        AND date_trunc('month', l.occurred_at::timestamptz AT TIME ZONE 'America/Sao_Paulo') = to_timestamp($1 || '-01', 'YYYY-MM-DD')::timestamp
      GROUP BY 1`,
    params,
  );
  const byClass = new Map(volume.rows.map((v) => [v.method_class, Number(v.cents)]));

  const exceptions = await client.query<{ kind: string; n: number }>(
    `SELECT kind, count(*)::int AS n FROM cbr_cases
      WHERE date_trunc('month', created_at AT TIME ZONE 'America/Sao_Paulo') = to_timestamp($1 || '-01', 'YYYY-MM-DD')::timestamp
      GROUP BY kind ORDER BY kind`,
    params,
  );

  return {
    month,
    timezone: 'America/Sao_Paulo',
    settledBills: r.settled,
    confirmedBills: r.confirmed,
    completionRate: r.confirmed > 0 ? Number((r.settled_of_confirmed / r.confirmed).toFixed(4)) : null,
    averageParticipants: r.avg_participants === null ? null : Number(Number(r.avg_participants).toFixed(2)),
    medianMinutesToSettle: r.median_minutes === null ? null : Number(Number(r.median_minutes).toFixed(1)),
    volume: {
      declaredManualCents: byClass.get('manual') ?? 0,
      sandboxTestCents: byClass.get('sandbox') ?? 0,
      providerCents: byClass.get('provider') ?? 0,
    },
    exceptions: Object.fromEntries(exceptions.rows.map((e) => [e.kind, e.n])),
  };
}

/** "YYYY-MM" do instante dado, no fuso de São Paulo. */
export function saoPauloMonth(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(at);
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}
