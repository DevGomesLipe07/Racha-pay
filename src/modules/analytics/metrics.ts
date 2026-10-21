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

export interface DailyRow {
  establishmentId: string | null;
  establishmentName: string | null;
  billsOpened: number;
  billsSettled: number;
  billsStillOpen: number;
  confirmed: { declaredManualCents: number; sandboxTestCents: number; providerCents: number };
  reversedCents: number;
  openCases: number;
}

/** Conciliação diária por estabelecimento (dia no fuso de São Paulo), a partir do ledger. */
export async function dailyReport(client: PoolClient, date: string): Promise<{ date: string; timezone: 'America/Sao_Paulo'; establishments: DailyRow[] }> {
  const { rows } = await client.query<{
    establishment_id: string | null;
    name: string | null;
    opened: number;
    settled: number;
    still_open: number;
    manual: string;
    sandbox: string;
    provider: string;
    reversed: string;
    open_cases: number;
  }>(
    `WITH d AS (SELECT to_date($1, 'YYYY-MM-DD') AS day),
     ev AS (
       SELECT l.bill_id, l.type, l.payload, (l.occurred_at::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date AS day
         FROM ledger_entries l
     ),
     money AS (
       SELECT ev.bill_id,
              SUM(CASE WHEN ev.type = 'PAYMENT_CONFIRMED' AND p.method = 'MANUAL' THEN (ev.payload->>'amountCents')::bigint ELSE 0 END) AS manual,
              SUM(CASE WHEN ev.type = 'PAYMENT_CONFIRMED' AND p.method = 'SANDBOX' THEN (ev.payload->>'amountCents')::bigint ELSE 0 END) AS sandbox,
              SUM(CASE WHEN ev.type = 'PAYMENT_CONFIRMED' AND p.method LIKE 'PSP:%' THEN (ev.payload->>'amountCents')::bigint ELSE 0 END) AS provider,
              SUM(CASE WHEN ev.type IN ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEDBACK') THEN (ev.payload->>'amountCents')::bigint ELSE 0 END) AS reversed
         FROM ev JOIN payments p ON p.id = (ev.payload->>'paymentId')::uuid, d
        WHERE ev.day = d.day AND ev.type IN ('PAYMENT_CONFIRMED', 'PAYMENT_REFUNDED', 'PAYMENT_CHARGEDBACK')
        GROUP BY ev.bill_id
     ),
     per_bill AS (
       SELECT b.id, b.establishment_id, b.state,
              ((b.created_at AT TIME ZONE 'America/Sao_Paulo')::date = d.day) AS opened_today,
              EXISTS (SELECT 1 FROM ev WHERE ev.bill_id = b.id AND ev.type = 'BILL_STATE_CHANGED' AND ev.payload->>'to' = 'SETTLED' AND ev.day = d.day) AS settled_today,
              (SELECT count(*) FROM cbr_cases c WHERE c.bill_id = b.id AND c.status = 'OPEN') AS cases
         FROM bills b, d
     )
     SELECT pb.establishment_id, e.name,
            count(*) FILTER (WHERE pb.opened_today)::int AS opened,
            count(*) FILTER (WHERE pb.settled_today)::int AS settled,
            count(*) FILTER (WHERE pb.opened_today AND pb.state NOT IN ('SETTLED', 'CANCELLED'))::int AS still_open,
            COALESCE(SUM(m.manual), 0)::bigint AS manual,
            COALESCE(SUM(m.sandbox), 0)::bigint AS sandbox,
            COALESCE(SUM(m.provider), 0)::bigint AS provider,
            COALESCE(SUM(m.reversed), 0)::bigint AS reversed,
            COALESCE(SUM(pb.cases), 0)::int AS open_cases
       FROM per_bill pb
       LEFT JOIN money m ON m.bill_id = pb.id
       LEFT JOIN establishments e ON e.id = pb.establishment_id
      GROUP BY pb.establishment_id, e.name
     HAVING count(*) FILTER (WHERE pb.opened_today OR pb.settled_today) > 0 OR COALESCE(SUM(m.manual + m.sandbox + m.provider + m.reversed), 0) > 0
      ORDER BY e.name NULLS LAST`,
    [date],
  );
  return {
    date,
    timezone: 'America/Sao_Paulo',
    establishments: rows.map((r) => ({
      establishmentId: r.establishment_id,
      establishmentName: r.name,
      billsOpened: r.opened,
      billsSettled: r.settled,
      billsStillOpen: r.still_open,
      confirmed: { declaredManualCents: Number(r.manual), sandboxTestCents: Number(r.sandbox), providerCents: Number(r.provider) },
      reversedCents: Number(r.reversed),
      openCases: r.open_cases,
    })),
  };
}

/** "YYYY-MM-DD" do instante dado, no fuso de São Paulo. */
export function saoPauloDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** "YYYY-MM" do instante dado, no fuso de São Paulo. */
export function saoPauloMonth(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(at);
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}
