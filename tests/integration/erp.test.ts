import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, inScope, openTestDb, resetDatabase, type TestDb } from './helpers.ts';
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

const SCOPES = ['bills:read', 'bills:write', 'payments:create', 'payments:write', 'erp:sync', 'establishments:write'];

async function restaurant() {
  const tenantId = await createTenant(db, `Restaurante ${randomUUID().slice(0, 6)}`);
  const key = await createApiKey(db, tenantId, SCOPES);
  const as = { key, actor: 'erp' };
  const est = await api(app, 'POST', '/v1/establishments', { as, body: { externalId: 'loja-centro', name: 'Loja Centro' } });
  assert.equal(est.status, 201, JSON.stringify(est.body));
  return { tenantId, as };
}

const comanda = (over: Record<string, unknown> = {}) => ({
  externalReference: 'comanda-42',
  establishmentExternalId: 'loja-centro',
  tableLabel: '12',
  kind: 'RESTAURANT',
  currency: 'BRL',
  participants: ['Cliente 1', 'Cliente 2'],
  items: [
    { externalRef: 'p1', description: 'Picanha', unitPriceCents: 8990, quantity: 1 },
    { externalRef: 'p2', description: 'Chopp', unitPriceCents: 1200, quantity: 2 },
  ],
  discountCents: 0,
  serviceBp: 1000,
  tipCents: 0,
  ...over,
});

const sync = (as: object, body: unknown, provider = 'generic') => api(app, 'POST', `/v1/integrations/erp/${provider}/sync`, { as: as as never, body });

test('estabelecimentos: cadastro, listagem e externalId único por tenant', async () => {
  const r = await restaurant();
  const list = await api(app, 'GET', '/v1/establishments', { as: r.as });
  assert.deepEqual(list.body.establishments.map((e: { externalId: string }) => e.externalId), ['loja-centro']);
  assert.equal((await api(app, 'POST', '/v1/establishments', { as: r.as, body: { externalId: 'loja-centro', name: 'X' } })).status, 409);
  const other = await restaurant();
  assert.equal((await api(app, 'GET', '/v1/establishments', { as: other.as })).body.establishments.length, 1);
});

test('sync idempotente: CREATED (com link da mesa) → UNCHANGED → UPDATED em rascunho', async () => {
  const r = await restaurant();
  const created = await sync(r.as, comanda());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.result, 'CREATED');
  assert.match(created.body.shareUrl, /#\/s\/[0-9a-f-]{36}\/rps_/);
  assert.equal(created.body.bill.collectionModel, 'MERCHANT_COLLECTS');
  assert.equal(created.body.bill.tableLabel, '12');
  assert.equal(created.body.bill.items.length, 2);

  const same = await sync(r.as, comanda());
  assert.equal(same.status, 200);
  assert.equal(same.body.result, 'UNCHANGED');
  assert.equal(same.body.billId, created.body.billId);

  const changed = await sync(r.as, comanda({ items: [{ externalRef: 'p1', description: 'Picanha', unitPriceCents: 9490, quantity: 1 }], tipCents: 500 }));
  assert.equal(changed.body.result, 'UPDATED');
  assert.deepEqual(changed.body.bill.items.map((i: { externalRef: string; unitPriceCents: number }) => [i.externalRef, i.unitPriceCents]), [['p1', 9490]]);
  assert.equal(changed.body.bill.tipCents, 500);
});

test('depois da divisão: acréscimo do ERP vira complemento (D2); alterar item confirmado → 409 ERP_DIVERGENCE + caso', async () => {
  const r = await restaurant();
  const created = await sync(r.as, comanda({ externalReference: 'comanda-77' }));
  const id = created.body.billId;
  const pv = await api(app, 'POST', `/v1/bills/${id}/splits/preview`, { as: r.as });
  const total1 = pv.body.preview.totals.totalCents;
  assert.equal(total1, Math.round((8990 + 2400) * 1.1));
  assert.equal((await api(app, 'POST', `/v1/bills/${id}/splits`, { as: r.as, body: { expectedTotalCents: total1 } })).status, 201);

  const more = await sync(r.as, comanda({ externalReference: 'comanda-77', items: [...comanda().items, { externalRef: 'p3', description: 'Sobremesa', unitPriceCents: 2000, quantity: 1 }] }));
  assert.equal(more.status, 200, JSON.stringify(more.body));
  assert.equal(more.body.result, 'COMPLEMENTED');
  assert.equal(more.body.splitVersion, 2);
  assert.equal(more.body.bill.split.totalCents, total1 + 2200);

  const tampered = await sync(r.as, comanda({ externalReference: 'comanda-77', items: [{ externalRef: 'p1', description: 'Picanha', unitPriceCents: 1, quantity: 1 }, comanda().items[1], { externalRef: 'p3', description: 'Sobremesa', unitPriceCents: 2000, quantity: 1 }] }));
  assert.equal(tampered.status, 409);
  assert.equal(tampered.body.error.code, 'ERP_DIVERGENCE');
  assert.equal(tampered.body.error.details.divergence[0].itemRef, 'p1');
  const cases = await inScope(db, { kind: 'tenant', tenantId: r.tenantId }, (c) => c.query("SELECT kind, status FROM cbr_cases WHERE bill_id = $1", [id]));
  assert.deepEqual(cases.rows, [{ kind: 'ERP_DIVERGENCE', status: 'OPEN' }]);
  const after = await api(app, 'GET', `/v1/bills/${id}`, { as: r.as });
  assert.equal(after.body.bill.split.totalCents, total1 + 2200, 'nada mudou na conta');
  const removed = await sync(r.as, comanda({ externalReference: 'comanda-77', items: [comanda().items[0]] }));
  assert.equal(removed.body.error.code, 'ERP_DIVERGENCE');
  const discount = await sync(r.as, comanda({ externalReference: 'comanda-77', discountCents: 100, items: [...comanda().items, { externalRef: 'p3', description: 'Sobremesa', unitPriceCents: 2000, quantity: 1 }] }));
  assert.equal(discount.body.error.code, 'ERP_DIVERGENCE');
});

test('ack do ERP vai para o ledger; ERP nativo bloqueado responde 501; validação e permissões', async () => {
  const r = await restaurant();
  const created = await sync(r.as, comanda({ externalReference: 'comanda-ack' }));
  const ack = await api(app, 'POST', '/v1/integrations/erp/generic/ack', { as: r.as, body: { externalReference: 'comanda-ack', event: 'bill.settled', erpDocument: 'NF-123' } });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  const ledger = await api(app, 'GET', `/v1/bills/${created.body.billId}/ledger`, { as: r.as });
  const last = ledger.body.entries.at(-1);
  assert.equal(last.type, 'ERP_ACKNOWLEDGED');
  assert.deepEqual(last.payload, { provider: 'generic', event: 'bill.settled', erpDocument: 'NF-123' });
  assert.equal(ledger.body.verification.valid, true);

  const nexflow = await sync(r.as, comanda(), 'nexflow');
  assert.equal(nexflow.status, 501);
  assert.equal(nexflow.body.error.code, 'ERP_ADAPTER_BLOCKED');
  assert.equal((await sync(r.as, comanda(), 'sap')).status, 404);
  assert.equal((await sync(r.as, comanda({ establishmentExternalId: 'loja-inexistente', externalReference: 'c-x' }))).body.error.code, 'ESTABLISHMENT_NOT_FOUND');
  const dup = await sync(r.as, comanda({ externalReference: 'c-dup', items: [comanda().items[0], comanda().items[0]] }));
  assert.equal(dup.status, 422);
  assert.equal((await sync(r.as, { ...comanda(), unitPrice: 1 })).status, 422);

  const noErp = await createApiKey(db, r.tenantId, ['bills:read']);
  assert.equal((await sync({ key: noErp }, comanda())).status, 403);

  // Chave só de ERP (sem bills:write) não confirma complemento sozinha.
  const erpOnly = await createApiKey(db, r.tenantId, ['erp:sync', 'bills:read']);
  const c2 = await sync(r.as, comanda({ externalReference: 'comanda-limit' }));
  const pv = await api(app, 'POST', `/v1/bills/${c2.body.billId}/splits/preview`, { as: r.as });
  await api(app, 'POST', `/v1/bills/${c2.body.billId}/splits`, { as: r.as, body: { expectedTotalCents: pv.body.preview.totals.totalCents } });
  const blocked = await sync({ key: erpOnly }, comanda({ externalReference: 'comanda-limit', items: [...comanda().items, { externalRef: 'p9', description: 'Café', unitPriceCents: 500, quantity: 1 }] }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'COMPLEMENT_NOT_ALLOWED');
});
