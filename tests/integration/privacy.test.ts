import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inScope, openTestDb, PERSONAL_TENANT, resetDatabase, type TestDb } from './helpers.ts';
import { api, startApp, type TestApp } from './http.ts';
import { readLedger } from '../../src/modules/ledger/ledger-repo.ts';
import { reconstructFromLedger, verifyChain } from '../../src/modules/ledger/chain.ts';

let db: TestDb;
let app: TestApp;

before(async () => {
  await resetDatabase();
  db = await openTestDb();
  app = await startApp(db);
});
after(async () => {
  await app?.close();
  await db?.close();
});

async function settledBill(title: string) {
  const r = await api(app, 'POST', '/v1/bills', { body: { kind: 'RESTAURANT', title, organizerName: 'Ana Souza', participants: ['Bruno Lima'] } });
  const id = r.body.bill.id;
  const org = { organizer: r.body.organizerToken };
  const guest = { share: r.body.shareToken };
  const bruno = r.body.bill.participants[1].id;
  await api(app, 'POST', `/v1/bills/${id}/items`, { as: org, body: { description: 'Pizza da Ana', unitPriceCents: 10000 } });
  await api(app, 'POST', `/v1/bills/${id}/splits`, { as: org, body: { expectedTotalCents: 11000 } });
  const p = await api(app, 'POST', '/v1/payments', { as: guest, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: id, participantId: bruno } });
  await api(app, 'POST', `/v1/bills/${id}/payments/${p.body.payment.id}/confirm`, { as: org });
  assert.equal((await api(app, 'GET', `/v1/bills/${id}`, { as: org })).body.bill.state, 'SETTLED');
  return { id, org, guest };
}

const scope = (billId: string) => ({ kind: 'bill' as const, tenantId: PERSONAL_TENANT, billId });

test('D21: depois de 180 dias, conta quitada é anonimizada; links revogados; ledger íntegro e reconstruível', async () => {
  const old = await settledBill('Aniversário da Ana');
  app.clock.advance(100 * 86_400_000);
  const recent = await settledBill('Churrasco recente');
  app.clock.advance(81 * 86_400_000); // old: 181 dias; recent: 81 dias

  const before = await inScope(db, scope(old.id), async (c) => readLedger(c, old.id));
  const r = await app.runRetention();
  assert.ok(r.anonymized >= 1);

  const data = await inScope(db, scope(old.id), async (c) => ({
    bill: (await c.query('SELECT title, anonymized_at FROM bills WHERE id = $1', [old.id])).rows[0],
    names: (await c.query('SELECT name FROM participants WHERE bill_id = $1 ORDER BY position', [old.id])).rows.map((x) => x.name),
    items: (await c.query('SELECT description FROM items WHERE bill_id = $1', [old.id])).rows.map((x) => x.description),
    keys: (await c.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE bill_id = $1', [old.id])).rows[0].n,
    ledger: await readLedger(c, old.id),
  }));
  assert.equal(data.bill.title, 'Conta anonimizada');
  assert.ok(data.bill.anonymized_at);
  assert.deepEqual(data.names, ['Participante 1', 'Participante 2']);
  assert.deepEqual(data.items, ['Item 1']);
  assert.equal(data.keys, 0);
  // Ledger intocado: mesma cadeia, mesma reconstrução de devido/pago.
  assert.deepEqual(data.ledger, before);
  assert.equal(verifyChain(data.ledger).valid, true);
  assert.equal(reconstructFromLedger(data.ledger).participants.size, 2);
  assert.equal(JSON.stringify(data.ledger).includes('Ana'), false, 'ledger nunca teve nomes');

  // Links antigos deixam de funcionar.
  assert.equal((await api(app, 'GET', `/v1/bills/${old.id}`, { as: old.org })).status, 401);
  assert.equal((await api(app, 'GET', `/v1/bills/${old.id}`, { as: old.guest })).status, 401);

  // Conta recente não é tocada.
  assert.equal((await api(app, 'GET', `/v1/bills/${recent.id}`, { as: recent.org })).body.bill.title, 'Churrasco recente');

  // Idempotente: rodar de novo não muda nada.
  const again = await app.runRetention();
  assert.equal(again.anonymized, 0);
});

test('D21: rascunho abandonado por mais de 365 dias é anonimizado; com pagamento em andamento não é', async () => {
  const draft = await api(app, 'POST', '/v1/bills', { body: { title: 'Viagem que não rolou', organizerName: 'Carla', participants: ['Davi'] } });
  const open = await api(app, 'POST', '/v1/bills', { body: { title: 'Com Pix pendente', organizerName: 'Eva', participants: ['Fábio'] } });
  const oid = open.body.bill.id;
  await api(app, 'POST', `/v1/bills/${oid}/items`, { as: { organizer: open.body.organizerToken }, body: { description: 'x', unitPriceCents: 1000 } });
  await api(app, 'POST', `/v1/bills/${oid}/splits`, { as: { organizer: open.body.organizerToken }, body: { expectedTotalCents: 1000 } });
  await api(app, 'POST', '/v1/payments', {
    as: { share: open.body.shareToken },
    headers: { 'idempotency-key': `k-${randomUUID()}` },
    body: { billId: oid, participantId: open.body.bill.participants[1].id },
  });
  app.clock.advance(366 * 86_400_000);
  // O pagamento manual pendente expira em 7 dias; aqui ele ainda consta como pendente porque o worker de
  // expiração não rodou — a retenção não pode anonimizar conta com pagamento em andamento.
  await app.runRetention();
  const titles = await inScope(db, { kind: 'tenant', tenantId: PERSONAL_TENANT }, (c) =>
    c.query('SELECT id, title FROM bills WHERE id = ANY($1::uuid[])', [[draft.body.bill.id, oid]]),
  );
  const byId = Object.fromEntries(titles.rows.map((r) => [r.id, r.title]));
  assert.equal(byId[draft.body.bill.id], 'Conta anonimizada');
  assert.equal(byId[oid], 'Com Pix pendente');
});

test('D21: titular pede anonimização; recusada com pagamento em andamento; convidado não pode pedir', async () => {
  const b = await settledBill('Pedido do titular');
  assert.equal((await api(app, 'POST', `/v1/bills/${b.id}/anonymize`, { as: b.guest })).status, 403);
  const ok = await api(app, 'POST', `/v1/bills/${b.id}/anonymize`, { as: b.org });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.anonymized.participants, 2);
  assert.equal(ok.body.anonymized.revokedTokens, 2);
  assert.equal((await api(app, 'GET', `/v1/bills/${b.id}`, { as: b.org })).status, 401);

  const p = await api(app, 'POST', '/v1/bills', { body: { title: 'Ainda pagando', organizerName: 'Gil', participants: ['Hugo'] } });
  const org = { organizer: p.body.organizerToken };
  await api(app, 'POST', `/v1/bills/${p.body.bill.id}/items`, { as: org, body: { description: 'x', unitPriceCents: 1000 } });
  await api(app, 'POST', `/v1/bills/${p.body.bill.id}/splits`, { as: org, body: { expectedTotalCents: 1000 } });
  await api(app, 'POST', '/v1/payments', { as: { share: p.body.shareToken }, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: p.body.bill.id, participantId: p.body.bill.participants[1].id } });
  assert.equal((await api(app, 'POST', `/v1/bills/${p.body.bill.id}/anonymize`, { as: org })).body.error.code, 'PAYMENT_IN_PROGRESS');
});

test('chaves de idempotência vencidas são apagadas pela rotina', async () => {
  const b = await api(app, 'POST', '/v1/bills', { body: { title: 'Chaves', organizerName: 'Ivo', participants: ['Jó'] } });
  const org = { organizer: b.body.organizerToken };
  await api(app, 'POST', `/v1/bills/${b.body.bill.id}/items`, { as: org, body: { description: 'x', unitPriceCents: 1000 } });
  await api(app, 'POST', `/v1/bills/${b.body.bill.id}/splits`, { as: org, body: { expectedTotalCents: 1000 } });
  await api(app, 'POST', '/v1/payments', { as: { share: b.body.shareToken }, headers: { 'idempotency-key': 'chave-que-vai-vencer' }, body: { billId: b.body.bill.id, participantId: b.body.bill.participants[1].id } });
  app.clock.advance(25 * 3600 * 1000);
  const r = await app.runRetention();
  assert.ok(r.purgedKeys >= 1);
});
