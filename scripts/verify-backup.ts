// npm run backup:verify -- --dump rachapay.dump
// Prova que o backup restaura: recria um banco descartável, restaura o dump e compara com a origem —
// contagem de linhas de cada tabela, cabeça da cadeia do ledger de cada conta, verificação completa de
// todas as cadeias de hash e migrations aplicadas. Sai com código 1 em qualquer divergência.
//
//   BACKUP_DATABASE_URL  origem (papel rachapay_backup, só leitura, BYPASSRLS)
//   RESTORE_ADMIN_URL    administrador do servidor de destino (cria o banco descartável e restaura)
//   RESTORE_DB_NAME      banco descartável (padrão: rachapay_restore_check) — é APAGADO e recriado

import { parseArgs } from 'node:util';
import pg from 'pg';
import { pgTool } from './pg-tools.ts';
import { verifyChain, type LedgerEntry } from '../src/modules/ledger/chain.ts';
import { loadMigrations } from '../src/infra/db/migrate.ts';

const { values } = parseArgs({ options: { dump: { type: 'string' } } });
const source = process.env.BACKUP_DATABASE_URL;
const admin = process.env.RESTORE_ADMIN_URL;
const dbName = process.env.RESTORE_DB_NAME ?? 'rachapay_restore_check';
if (!source || !admin || !values.dump) {
  process.stderr.write('uso: BACKUP_DATABASE_URL=… RESTORE_ADMIN_URL=… npm run backup:verify -- --dump arquivo.dump\n');
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]{2,62}$/.test(dbName) || /^rachapay(_test)?$/.test(dbName)) {
  process.stderr.write('RESTORE_DB_NAME inválido (e nunca o banco principal)\n');
  process.exit(1);
}
interface Snapshot {
  tables: Record<string, number>;
  ledgerHeads: Record<string, string>;
  migrations: number;
  chainsValid: number;
  chainsBroken: string[];
}

async function snapshot(url: string): Promise<Snapshot> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tables = (await client.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.t);
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = Number((await client.query(`SELECT count(*) AS n FROM public."${t.replace(/"/g, '')}"`)).rows[0].n);
    const heads = await client.query<{ bill_id: string; entry_hash: string }>(
      'SELECT DISTINCT ON (bill_id) bill_id, entry_hash FROM ledger_entries ORDER BY bill_id, seq DESC',
    );
    const rows = await client.query(
      `SELECT bill_id, seq, type, payload, actor_type, actor_id, correlation_id, occurred_at, prev_hash, entry_hash
         FROM ledger_entries ORDER BY bill_id, seq`,
    );
    const byBill = new Map<string, LedgerEntry[]>();
    for (const r of rows.rows) {
      const list = byBill.get(r.bill_id) ?? [];
      list.push({
        billId: r.bill_id,
        seq: r.seq,
        type: r.type,
        payload: r.payload,
        actor: { type: r.actor_type, id: r.actor_id },
        correlationId: r.correlation_id,
        occurredAt: r.occurred_at,
        prevHash: r.prev_hash,
        entryHash: r.entry_hash,
      });
      byBill.set(r.bill_id, list);
    }
    const broken = [...byBill].filter(([, entries]) => !verifyChain(entries).valid).map(([id]) => id);
    const migrations = Number((await client.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n);
    return {
      tables: counts,
      ledgerHeads: Object.fromEntries(heads.rows.map((h) => [h.bill_id, h.entry_hash])),
      migrations,
      chainsValid: byBill.size - broken.length,
      chainsBroken: broken,
    };
  } finally {
    await client.end();
  }
}

const problems: string[] = [];
const before = await snapshot(source);

const adminClient = new pg.Client({ connectionString: admin });
await adminClient.connect();
await adminClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await adminClient.query(`CREATE DATABASE ${dbName} OWNER rachapay_owner TEMPLATE template0 ENCODING 'UTF8'`);
await adminClient.end();

const targetUrl = new URL(admin);
targetUrl.pathname = `/${dbName}`;
try {
  pgTool('pg_restore', ['--exit-on-error', '--no-password', values.dump], targetUrl.toString());
} catch (error) {
  process.stderr.write(`pg_restore falhou: ${(error as Error).message}\n`);
  process.exit(1);
}
const after = await snapshot(targetUrl.toString());

for (const [t, n] of Object.entries(before.tables)) {
  if (after.tables[t] !== n) problems.push(`tabela ${t}: origem ${n}, restaurado ${after.tables[t] ?? 'ausente'}`);
}
for (const [bill, head] of Object.entries(before.ledgerHeads)) {
  if (after.ledgerHeads[bill] !== head) problems.push(`ledger da conta ${bill.slice(0, 8)}…: cabeça da cadeia diferente`);
}
if (after.chainsBroken.length > 0) problems.push(`${after.chainsBroken.length} cadeia(s) de ledger inválida(s) no restaurado`);
const expectedMigrations = (await loadMigrations()).length;
if (after.migrations !== expectedMigrations) problems.push(`migrations: restaurado tem ${after.migrations}, código tem ${expectedMigrations}`);

const report = {
  ok: problems.length === 0,
  tables: Object.keys(before.tables).length,
  rows: Object.values(before.tables).reduce((a, b) => a + b, 0),
  ledgerChains: after.chainsValid,
  migrations: after.migrations,
  problems,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);
