import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, openTestDb, resetDatabase, type TestDb } from './helpers.ts';
import { api, createApiKey, startApp, type TestApp } from './http.ts';

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

const ALL = ['bills:read', 'bills:write', 'payments:create', 'payments:write', 'establishments:write', 'metrics:read', 'knowledge:read', 'knowledge:write', 'knowledge:approve'];

async function business() {
  const tenantId = await createTenant(db, `Rede ${randomUUID().slice(0, 6)}`);
  const ana = { key: await createApiKey(db, tenantId, ALL, 'HUMAN'), actor: 'gerente-ana' };
  const bia = { key: await createApiKey(db, tenantId, ALL, 'HUMAN'), actor: 'gerente-bia' };
  const centro = (await api(app, 'POST', '/v1/establishments', { as: ana, body: { externalId: 'centro', name: 'Centro' } })).body.establishment;
  const praia = (await api(app, 'POST', '/v1/establishments', { as: ana, body: { externalId: 'praia', name: 'Praia' } })).body.establishment;
  return { tenantId, ana, bia, centro, praia };
}

const openTable = (as: object, establishmentId: string, label: string) =>
  api(app, 'POST', '/v1/bills', { as: as as never, body: { kind: 'RESTAURANT', title: `Mesa ${label}`, tableLabel: label, establishmentId, participants: ['A', 'B'] } });

test('lista de contas do tenant: abertas, por estabelecimento, contadores; token de conta não lista', async () => {
  const t = await business();
  const m1 = (await openTable(t.ana, t.centro.id, '1')).body.bill;
  await openTable(t.ana, t.centro.id, '2');
  await openTable(t.ana, t.praia.id, '9');
  await api(app, 'POST', `/v1/bills/${m1.id}/items`, { as: t.ana, body: { description: 'Prato', unitPriceCents: 10000 } });
  const pv = await api(app, 'POST', `/v1/bills/${m1.id}/splits/preview`, { as: t.ana });
  await api(app, 'POST', `/v1/bills/${m1.id}/splits`, { as: t.ana, body: { expectedTotalCents: pv.body.preview.totals.totalCents } });
  await api(app, 'POST', '/v1/payments', { as: t.ana, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: m1.id, participantId: m1.participants[0].id } });

  const centro = await api(app, 'GET', `/v1/bills?open=true&establishmentId=${t.centro.id}`, { as: t.ana });
  assert.equal(centro.status, 200, JSON.stringify(centro.body));
  assert.deepEqual(centro.body.bills.map((b: { tableLabel: string }) => b.tableLabel).sort(), ['1', '2']);
  const mesa1 = centro.body.bills.find((b: { tableLabel: string }) => b.tableLabel === '1');
  assert.equal(mesa1.totalCents, 11000);
  assert.equal(mesa1.pendingManualPayments, 1);
  assert.equal(mesa1.participants, 2);
  assert.equal((await api(app, 'GET', '/v1/bills?state=DRAFT', { as: t.ana })).body.bills.length, 2);
  assert.equal((await api(app, 'GET', '/v1/bills?state=NADA', { as: t.ana })).status, 422);

  const other = await business();
  assert.equal((await api(app, 'GET', '/v1/bills', { as: other.ana })).body.bills.length, 0, 'outro tenant não vê nada');
  const personal = await api(app, 'POST', '/v1/bills', { body: { title: 'P', organizerName: 'X' } });
  assert.equal((await api(app, 'GET', '/v1/bills', { as: { organizer: personal.body.organizerToken } })).status, 403);
  assert.equal((await api(app, 'POST', '/v1/bills', { body: { title: 'P', organizerName: 'X', establishmentId: t.centro.id } })).status, 403);
  assert.equal((await openTable(other.ana, t.centro.id, '1')).body.error.code, 'ESTABLISHMENT_NOT_FOUND', 'estabelecimento de outro tenant não existe para ele');
});

test('regra de escopo ESTABLISHMENT passa a valer nas mesas daquele estabelecimento', async () => {
  const t = await business();
  const k = (await api(app, 'POST', '/v1/knowledge', {
    as: t.ana,
    body: { key: 'SERVICE_CHARGE.DEFAULT', scopeType: 'ESTABLISHMENT', scopeValue: t.praia.id, content: { bp: 1300, maxBp: 3000 }, rationale: 'quiosque da praia cobra 13%' },
  })).body.knowledge;
  for (const [as, to] of [[t.ana, 'REVIEW'], [t.bia, 'APPROVED'], [t.ana, 'ACTIVE']] as const) {
    assert.equal((await api(app, 'POST', `/v1/knowledge/${k.id}/transition`, { as, body: { to } })).status, 200, to);
  }
  assert.equal((await openTable(t.ana, t.praia.id, '5')).body.bill.serviceBp, 1300);
  assert.equal((await openTable(t.ana, t.centro.id, '5')).body.bill.serviceBp, 1000, 'outro estabelecimento segue a regra do segmento');
});

test('conciliação do dia por estabelecimento: abertas, quitadas, declarado no caixa', async () => {
  const t = await business();
  const m = (await openTable(t.ana, t.centro.id, '3')).body.bill;
  await api(app, 'POST', `/v1/bills/${m.id}/items`, { as: t.ana, body: { description: 'Prato', unitPriceCents: 10000 } });
  await api(app, 'POST', `/v1/bills/${m.id}/splits`, { as: t.ana, body: { expectedTotalCents: 11000 } });
  for (const p of m.participants) {
    const pay = await api(app, 'POST', '/v1/payments', { as: t.ana, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: m.id, participantId: p.id } });
    assert.equal((await api(app, 'POST', `/v1/bills/${m.id}/payments/${pay.body.payment.id}/confirm`, { as: t.ana })).status, 200);
  }
  await openTable(t.ana, t.praia.id, '7');
  const r = await api(app, 'GET', '/v1/reports/daily?date=2026-10-21', { as: t.ana });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byName = Object.fromEntries(r.body.report.establishments.map((e: { establishmentName: string }) => [e.establishmentName, e]));
  assert.equal(byName.Centro.billsOpened, 1);
  assert.equal(byName.Centro.billsSettled, 1);
  assert.equal(byName.Centro.billsStillOpen, 0);
  assert.equal(byName.Centro.confirmed.declaredManualCents, 11000);
  assert.equal(byName.Praia.billsOpened, 1);
  assert.equal(byName.Praia.billsStillOpen, 1);
  assert.equal((await api(app, 'GET', '/v1/reports/daily?date=2026-10-20', { as: t.ana })).body.report.establishments.length, 0);
  assert.equal((await api(app, 'GET', '/v1/reports/daily?date=21/10', { as: t.ana })).body.error.code, 'INVALID_DATE');
});
