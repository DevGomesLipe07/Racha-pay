import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTenant, insertBill, inScope, openTestDb, PERSONAL_TENANT, resetDatabase, sqlError, type TestDb } from './helpers.ts';
import { migrate, MIGRATIONS_DIR, MigrationError } from '../../src/infra/db/migrate.ts';
import { inspectRole, roleProblems } from '../../src/infra/db/role-check.ts';
import { withoutScope } from '../../src/infra/db/tx.ts';
import { appendLedger, readLedger } from '../../src/modules/ledger/ledger-repo.ts';
import { verifyChain, type LedgerEntryDraft } from '../../src/modules/ledger/chain.ts';
import { hashToken, newToken } from '../../src/infra/crypto/hash.ts';

let db: TestDb;

before(async () => {
  await resetDatabase();
  db = await openTestDb();
});
after(async () => {
  await db?.close();
});

const draft = (billId: string, type: LedgerEntryDraft['type'], payload: LedgerEntryDraft['payload'] = {}): LedgerEntryDraft => ({
  billId,
  type,
  payload,
  actor: { type: 'HUMAN', id: 'org' },
  correlationId: randomUUID(),
  occurredAt: new Date().toISOString(),
});

test('migrations: reaplicar é idempotente', async () => {
  const r = await migrate(db.owner);
  assert.deepEqual(r.applied, []);
  assert.ok(r.alreadyApplied >= 1);
});

test('migrations: arquivo editado depois de aplicado é recusado por checksum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rachapay-mig-'));
  try {
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const file = join(dir, '0001_core.sql');
    await writeFile(file, `${await readFile(file, 'utf8')}\n-- edição indevida\n`);
    await assert.rejects(migrate(db.owner, dir), (e: unknown) => e instanceof MigrationError && /checksum/.test(e.message));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('papel da aplicação: sem superuser, sem BYPASSRLS e não é dono das tabelas', async () => {
  const report = await inspectRole(db.app);
  assert.equal(report.role, 'rachapay_app');
  assert.deepEqual(roleProblems(report), []);
  const owner = await inspectRole(db.owner);
  assert.equal(owner.superuser, false);
  assert.equal(owner.bypassRls, false);
  assert.match(roleProblems(owner).join(), /dono das tabelas/);
});

test('RLS: sem escopo a aplicação não vê nenhuma conta', async () => {
  await insertBill(db, PERSONAL_TENANT);
  const { rows } = await db.app.query('SELECT count(*)::int AS n FROM bills');
  assert.equal(rows[0].n, 0);
});

test('RLS: tenant A não lê, não altera e não insere no tenant B (nem via SQL direto)', async () => {
  const a = await createTenant(db, 'Restaurante A');
  const b = await createTenant(db, 'Restaurante B');
  const billB = await insertBill(db, b, 'Mesa do B');

  const seen = await inScope(db, { kind: 'tenant', tenantId: a }, (c) => c.query('SELECT id FROM bills WHERE id = $1', [billB]));
  assert.equal(seen.rowCount, 0);

  const updated = await inScope(db, { kind: 'tenant', tenantId: a }, (c) =>
    c.query("UPDATE bills SET title = 'invadido' WHERE id = $1", [billB]),
  );
  assert.equal(updated.rowCount, 0);

  const insertErr = await sqlError(
    inScope(db, { kind: 'tenant', tenantId: a }, (c) =>
      c.query("INSERT INTO bills (id, tenant_id, kind, title, collection_model) VALUES ($1, $2, 'OTHER', 'x', 'MERCHANT_COLLECTS')", [randomUUID(), b]),
    ),
  );
  assert.equal(insertErr, '42501'); // violação de política RLS

  const participantErr = await sqlError(
    inScope(db, { kind: 'tenant', tenantId: a }, (c) =>
      c.query("INSERT INTO participants (tenant_id, bill_id, name, position) VALUES ($1, $2, 'x', 0)", [b, billB]),
    ),
  );
  assert.equal(participantErr, '42501');

  const title = await inScope(db, { kind: 'tenant', tenantId: b }, (c) => c.query('SELECT title FROM bills WHERE id = $1', [billB]));
  assert.equal(title.rows[0].title, 'Mesa do B');
});

test('D9: no tenant Pessoal, o token de uma conta não enxerga outra conta', async () => {
  const mine = await insertBill(db, PERSONAL_TENANT, 'Minha');
  const other = await insertBill(db, PERSONAL_TENANT, 'Do vizinho');
  await inScope(db, { kind: 'bill', tenantId: PERSONAL_TENANT, billId: other }, (c) =>
    c.query("INSERT INTO participants (tenant_id, bill_id, name, position) VALUES ($1, $2, 'Vizinho', 0)", [PERSONAL_TENANT, other]),
  );
  const res = await inScope(db, { kind: 'bill', tenantId: PERSONAL_TENANT, billId: mine }, async (c) => ({
    bills: (await c.query('SELECT id FROM bills')).rows.map((r) => r.id),
    participants: (await c.query('SELECT name FROM participants')).rowCount,
    update: (await c.query("UPDATE bills SET title = 'x' WHERE id = $1", [other])).rowCount,
  }));
  assert.deepEqual(res, { bills: [mine], participants: 0, update: 0 });
});

test('credenciais: a aplicação não lê tokens nem chaves; resolve só pelo hash', async () => {
  const bill = await insertBill(db, PERSONAL_TENANT);
  const { token, hash } = newToken('organizer');
  await inScope(db, { kind: 'bill', tenantId: PERSONAL_TENANT, billId: bill }, (c) =>
    c.query("INSERT INTO bill_tokens (token_hash, tenant_id, bill_id, kind) VALUES ($1, $2, $3, 'ORGANIZER')", [hash, PERSONAL_TENANT, bill]),
  );
  assert.equal(await sqlError(db.app.query('SELECT * FROM bill_tokens')), '42501');
  assert.equal(await sqlError(db.app.query('SELECT * FROM api_keys')), '42501');
  const resolved = await withoutScope(db.app, (c) => c.query('SELECT * FROM rp_resolve_bill_token($1)', [hashToken(token)]));
  assert.deepEqual(resolved.rows, [{ tenant_id: PERSONAL_TENANT, bill_id: bill, kind: 'ORGANIZER' }]);
  const none = await withoutScope(db.app, (c) => c.query('SELECT * FROM rp_resolve_bill_token($1)', [hashToken('rpo_falso')]));
  assert.equal(none.rowCount, 0);
  const otherBill = await insertBill(db, PERSONAL_TENANT);
  const crossIssue = await sqlError(
    inScope(db, { kind: 'bill', tenantId: PERSONAL_TENANT, billId: bill }, (c) =>
      c.query("INSERT INTO bill_tokens (token_hash, tenant_id, bill_id, kind) VALUES ($1, $2, $3, 'SHARE')", [
        newToken('share').hash,
        PERSONAL_TENANT,
        otherBill,
      ]),
    ),
  );
  assert.equal(crossIssue, '42501');
});

test('a aplicação não consegue desligar RLS nem remover triggers do ledger', async () => {
  assert.equal(await sqlError(db.app.query('ALTER TABLE bills DISABLE ROW LEVEL SECURITY')), '42501');
  assert.equal(await sqlError(db.app.query('ALTER TABLE bills NO FORCE ROW LEVEL SECURITY')), '42501');
  assert.equal(await sqlError(db.app.query('DROP TRIGGER ledger_entries_immutable ON ledger_entries')), '42501');
  assert.equal(await sqlError(db.app.query('CREATE TABLE x (id int)')), '42501');
});

test('ledger: hash sobrevive à ida e volta pelo banco e a cadeia verifica', async () => {
  const bill = await insertBill(db, PERSONAL_TENANT);
  const scope = { kind: 'bill' as const, tenantId: PERSONAL_TENANT, billId: bill };
  const entries = await inScope(db, scope, async (c) => {
    await appendLedger(c, PERSONAL_TENANT, draft(bill, 'BILL_CREATED', { kind: 'RESTAURANT', title: 'Pizza "da firma"' }));
    await appendLedger(c, PERSONAL_TENANT, draft(bill, 'SPLIT_CONFIRMED', { version: 1, allocations: [{ participantId: 'p', dueCents: 99_999_999_999n }] }));
    await appendLedger(c, PERSONAL_TENANT, draft(bill, 'PAYMENT_CONFIRMED', { participantId: 'p', amountCents: 1n, nested: { z: [1, 2], a: null } }));
    return readLedger(c, bill);
  });
  assert.equal(entries.length, 3);
  assert.deepEqual(verifyChain(entries), { valid: true, entries: 3 });
});

test('ledger: banco recusa UPDATE/DELETE/TRUNCATE (aplicação e dono) e encadeamento errado', async () => {
  const bill = await insertBill(db, PERSONAL_TENANT);
  const scope = { kind: 'bill' as const, tenantId: PERSONAL_TENANT, billId: bill };
  await inScope(db, scope, (c) => appendLedger(c, PERSONAL_TENANT, draft(bill, 'BILL_CREATED')));

  assert.equal(await sqlError(inScope(db, scope, (c) => c.query("UPDATE ledger_entries SET actor_id = 'x'"))), '42501');
  assert.equal(await sqlError(inScope(db, scope, (c) => c.query('DELETE FROM ledger_entries'))), '42501');
  assert.equal(await sqlError(db.app.query('TRUNCATE ledger_entries')), '42501');

  // Mesmo o dono (rachapay_owner), com RLS forçado e no escopo certo, esbarra na trigger.
  const ownerUpdate = await sqlError(
    (async () => {
      const c = await db.owner.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.bill_id', $2, true)", [PERSONAL_TENANT, bill]);
        await c.query("UPDATE ledger_entries SET actor_id = 'adulterado'");
        await c.query('COMMIT');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    })(),
  );
  assert.equal(ownerUpdate, '42501');
  assert.equal(await sqlError(db.owner.query('TRUNCATE ledger_entries')), '42501');

  const badChain = await sqlError(
    inScope(db, scope, (c) =>
      c.query(
        `INSERT INTO ledger_entries (tenant_id, bill_id, seq, type, payload, actor_type, actor_id, correlation_id, occurred_at, prev_hash, entry_hash)
         VALUES ($1, $2, 2, 'BILL_CANCELLED', '{}', 'HUMAN', 'x', 'c', '2026-10-21T00:00:00.000Z', $3, $4)`,
        [PERSONAL_TENANT, bill, 'f'.repeat(64), 'e'.repeat(64)],
      ),
    ),
  );
  assert.equal(badChain, '23514');
});
