import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createTenant, inScope, openTestDb, PERSONAL_TENANT, resetDatabase, type TestDb } from './helpers.ts';
import { api, createApiKey, startApp, type TestApp } from './http.ts';
import { hmacSha256Hex } from '../../src/infra/crypto/hash.ts';

let db: TestDb;
let app: TestApp;
let receiver: Server;
let receiverUrl: string;
let respondWith = 200;
const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];

before(async () => {
  await resetDatabase();
  db = await openTestDb();
  app = await startApp(db);
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(respondWith).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;
});
after(async () => {
  await new Promise((r) => receiver?.close(r));
  await app?.close();
  await db?.close();
});

async function business() {
  const tenantId = await createTenant(db, `Restaurante ${randomUUID().slice(0, 6)}`);
  const key = await createApiKey(db, tenantId, ['bills:read', 'bills:write', 'payments:create', 'payments:write', 'webhooks:write']);
  return { tenantId, as: { key, actor: 'caixa-1' } };
}

function verify(secret: string, header: string, body: string) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  return parts.v1 === hmacSha256Hex(secret, `${parts.t}.${body}`);
}

test('endpoint: só chave de tenant cadastra; segredo aparece uma vez e fica cifrado no banco', async () => {
  const t = await business();
  const created = await api(app, 'POST', '/v1/webhook-endpoints', { as: t.as, body: { url: receiverUrl, events: [] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.secret, /^whsec_/);
  const list = await api(app, 'GET', '/v1/webhook-endpoints', { as: t.as });
  assert.equal(list.body.endpoints.length, 1);
  assert.equal(JSON.stringify(list.body).includes(created.body.secret), false);
  const stored = await inScope(db, { kind: 'tenant', tenantId: t.tenantId }, (c) => c.query('SELECT secret_encrypted FROM webhook_endpoints'));
  assert.match(stored.rows[0].secret_encrypted, /^v1\./);
  assert.equal(stored.rows[0].secret_encrypted.includes(created.body.secret), false);

  const personal = await api(app, 'POST', '/v1/bills', { body: { title: 'x', organizerName: 'A' } });
  assert.equal((await api(app, 'POST', '/v1/webhook-endpoints', { as: { organizer: personal.body.organizerToken }, body: { url: receiverUrl } })).status, 403);
  const noScope = await createApiKey(db, t.tenantId, ['bills:read']);
  assert.equal((await api(app, 'POST', '/v1/webhook-endpoints', { as: { key: noScope }, body: { url: receiverUrl } })).status, 403);
});

test('eventos do ledger chegam assinados, com id para deduplicar, na ordem do fluxo', async () => {
  const t = await business();
  const ep = await api(app, 'POST', '/v1/webhook-endpoints', { as: t.as, body: { url: receiverUrl } });
  const secret = ep.body.secret;
  const bill = await api(app, 'POST', '/v1/bills', { as: t.as, body: { kind: 'RESTAURANT', title: 'Mesa 7', tableLabel: '7', participants: ['Cliente A', 'Cliente B'] } });
  const id = bill.body.bill.id;
  await api(app, 'POST', `/v1/bills/${id}/items`, { as: t.as, body: { description: 'Rodízio', unitPriceCents: 10000, quantity: 2 } });
  const pv = await api(app, 'POST', `/v1/bills/${id}/splits/preview`, { as: t.as });
  await api(app, 'POST', `/v1/bills/${id}/splits`, { as: t.as, body: { expectedTotalCents: pv.body.preview.totals.totalCents } });
  const a = bill.body.bill.participants[0].id;
  const p = await api(app, 'POST', '/v1/payments', { as: t.as, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: id, participantId: a, method: 'MANUAL' } });
  // Confirmação manual exige ator humano: a chave SYSTEM é recusada; a do caixa (HUMAN) confirma.
  assert.equal((await api(app, 'POST', `/v1/bills/${id}/payments/${p.body.payment.id}/confirm`, { as: t.as })).status, 403);
  const cashier = await createApiKey(db, t.tenantId, ['bills:read', 'payments:write'], 'HUMAN');
  const ok = await api(app, 'POST', `/v1/bills/${id}/payments/${p.body.payment.id}/confirm`, { as: { key: cashier, actor: 'caixa-ana' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  received.length = 0;
  const run = await app.runWebhooks();
  assert.equal(run.dead, 0);
  const mine = received.filter((r) => JSON.parse(r.body).data.billId === id);
  const types = mine.map((r) => r.headers['x-rachapay-event']);
  assert.deepEqual(types, ['bill.created', 'split.confirmed', 'payment.created', 'payment.confirmed', 'bill.partially_paid']);
  for (const r of mine) {
    const body = JSON.parse(r.body);
    assert.equal(body.version, '2026-10-01');
    assert.equal(r.headers['x-rachapay-event-id'], body.id);
    assert.ok(r.headers['x-rachapay-delivery']);
    assert.equal(verify(secret, String(r.headers['x-rachapay-signature']), r.body), true);
    assert.equal(body.data.tableLabel, '7');
  }
  const confirmed = JSON.parse(mine[3]!.body);
  assert.equal(confirmed.data.participantId, a);
  assert.equal(typeof confirmed.data.amountCents, 'number');

  // Nada novo: o worker não reenvia o que já foi entregue.
  received.length = 0;
  await app.runWebhooks();
  assert.equal(received.filter((r) => JSON.parse(r.body).data.billId === id).length, 0);
  const deliveries = await api(app, 'GET', '/v1/webhook-deliveries?status=DELIVERED', { as: t.as });
  assert.ok(deliveries.body.deliveries.length >= 5);
});

test('destino fora do ar: retentativa D17 (10 s, 20 s…), DEAD na 12ª falha, reprocessar entrega', async () => {
  const t = await business();
  await api(app, 'POST', '/v1/webhook-endpoints', { as: t.as, body: { url: receiverUrl, events: ['bill.created'] } });
  respondWith = 500;
  await api(app, 'POST', '/v1/bills', { as: t.as, body: { title: 'Mesa 9', participants: ['X'] } });
  await app.runWebhooks();
  let list = (await api(app, 'GET', '/v1/webhook-deliveries', { as: t.as })).body.deliveries;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'RETRYING');
  assert.equal(list[0].attempts, 1);
  assert.equal(list[0].lastStatusCode, 500);
  assert.equal(new Date(list[0].nextAttemptAt).getTime() - app.clock.now().getTime(), 10_000);

  // Antes do prazo não tenta de novo.
  await app.runWebhooks();
  assert.equal((await api(app, 'GET', '/v1/webhook-deliveries', { as: t.as })).body.deliveries[0].attempts, 1);

  for (let i = 0; i < 11; i++) {
    app.clock.advance(7 * 3600 * 1000);
    await app.runWebhooks();
  }
  list = (await api(app, 'GET', '/v1/webhook-deliveries', { as: t.as })).body.deliveries;
  assert.equal(list[0].status, 'DEAD');
  assert.equal(list[0].attempts, 12);

  respondWith = 200;
  const retry = await api(app, 'POST', `/v1/webhook-deliveries/${list[0].id}/retry`, { as: t.as });
  assert.equal(retry.status, 200);
  await app.runWebhooks();
  list = (await api(app, 'GET', '/v1/webhook-deliveries', { as: t.as })).body.deliveries;
  assert.equal(list[0].status, 'DELIVERED');
  assert.equal((await api(app, 'POST', `/v1/webhook-deliveries/${list[0].id}/retry`, { as: t.as })).body.error.code, 'ALREADY_DELIVERED');
});

test('tenant Pessoal (sem endpoints) não grava outbox; tenant não vê entregas de outro', async () => {
  const personal = await api(app, 'POST', '/v1/bills', { body: { title: 'Pessoal', organizerName: 'A' } });
  const outbox = await inScope(db, { kind: 'bill', tenantId: PERSONAL_TENANT, billId: personal.body.bill.id }, (c) => c.query('SELECT count(*)::int AS n FROM outbox_events'));
  assert.equal(outbox.rows[0].n, 0);
  const other = await business();
  assert.equal((await api(app, 'GET', '/v1/webhook-deliveries', { as: other.as })).body.deliveries.length, 0);
  assert.equal((await api(app, 'GET', '/v1/webhook-endpoints', { as: other.as })).body.endpoints.length, 0);
});
