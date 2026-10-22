import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, inScope, openTestDb, PERSONAL_TENANT, resetDatabase, type TestDb } from './helpers.ts';
import { api, createApiKey, startApp, type TestApp } from './http.ts';
import { crc16 } from '../../src/modules/payments/pix-brcode.ts';

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

/** Lê um campo EMV de primeiro nível (id de 2 dígitos + tamanho de 2 dígitos). */
function emv(payload: string, id: string): string | undefined {
  let i = 0;
  while (i < payload.length) {
    const fid = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    const value = payload.slice(i + 4, i + 4 + len);
    if (fid === id) return value;
    i += 4 + len;
  }
  return undefined;
}

async function confirmedBill() {
  const r = await api(app, 'POST', '/v1/bills', { body: { kind: 'RESTAURANT', title: 'Pizza', organizerName: 'Ana Conceição', participants: ['Bruno', 'Caio'] } });
  const id = r.body.bill.id;
  const org = { organizer: r.body.organizerToken };
  const guest = { share: r.body.shareToken };
  await api(app, 'POST', `/v1/bills/${id}/items`, { as: org, body: { description: 'Pizza', unitPriceCents: 9000 } });
  await api(app, 'POST', `/v1/bills/${id}/splits`, { as: org, body: { expectedTotalCents: 9900 } });
  return { id, org, guest, bruno: r.body.bill.participants[1].id as string };
}

test('D23: organizador configura chave; convidado recebe Pix com o valor exato da parte e CRC válido', async () => {
  const b = await confirmedBill();
  assert.equal((await api(app, 'PUT', `/v1/bills/${b.id}/pix`, { as: b.org, body: { pixKey: '123.456.789-00' } })).body.error.code, 'INVALID_PIX_KEY');
  assert.equal((await api(app, 'PUT', `/v1/bills/${b.id}/pix`, { as: b.guest, body: { pixKey: 'ana@exemplo.com' } })).status, 403);
  const set = await api(app, 'PUT', `/v1/bills/${b.id}/pix`, { as: b.org, body: { pixKey: 'Ana@Exemplo.com', pixCity: 'Campinas' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(set.body.bill.pix, { configured: true, type: 'EMAIL', keyMasked: 'an…@exemplo.com', city: 'Campinas' });

  const guestView = await api(app, 'GET', `/v1/bills/${b.id}`, { as: b.guest });
  assert.deepEqual(guestView.body.bill.pix, { configured: true }, 'convidado não vê a chave');

  const pix = await api(app, 'GET', `/v1/bills/${b.id}/participants/${b.bruno}/pix`, { as: b.guest });
  assert.equal(pix.status, 200, JSON.stringify(pix.body));
  const payload: string = pix.body.pix.payload;
  assert.equal(pix.body.pix.amountCents, 3300);
  assert.equal(emv(payload, '54'), '33.00');
  assert.equal(emv(payload, '53'), '986');
  assert.equal(emv(payload, '59'), 'Ana Conceicao');
  assert.equal(emv(payload, '60'), 'Campinas');
  assert.match(emv(payload, '26') ?? '', /0014br\.gov\.bcb\.pix0115ana@exemplo\.com/);
  assert.equal(payload.slice(-4), crc16(payload.slice(0, -4)));

  // Depois de pagar uma parte, o Pix vem com o que falta.
  await api(app, 'POST', '/v1/payments', { as: b.guest, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: b.id, participantId: b.bruno, amountCents: 1000 } });
  const rest = await api(app, 'GET', `/v1/bills/${b.id}/participants/${b.bruno}/pix`, { as: b.guest });
  assert.equal(rest.body.pix.amountCents, 2300);
});

test('D23: sem chave → 404; estabelecimento não usa Pix do organizador; remover; anonimizar apaga a chave', async () => {
  const b = await confirmedBill();
  assert.equal((await api(app, 'GET', `/v1/bills/${b.id}/participants/${b.bruno}/pix`, { as: b.guest })).status, 404);
  await api(app, 'PUT', `/v1/bills/${b.id}/pix`, { as: b.org, body: { pixKey: '123e4567-e12b-12d1-a456-426655440000' } });
  assert.equal((await api(app, 'PUT', `/v1/bills/${b.id}/pix`, { as: b.org, body: { pixKey: null } })).body.bill.pix.configured, false);

  const t = await createTenant(db, 'Bar');
  const key = await createApiKey(db, t, ['bills:read', 'bills:write']);
  const biz = await api(app, 'POST', '/v1/bills', { as: { key }, body: { title: 'Mesa', participants: ['A'] } });
  assert.equal((await api(app, 'PUT', `/v1/bills/${biz.body.bill.id}/pix`, { as: { key }, body: { pixKey: 'a@b.co' } })).body.error.code, 'PIX_NOT_APPLICABLE');

  await api(app, 'PUT', `/v1/bills/${b.id}/pix`, { as: b.org, body: { pixKey: 'ana@exemplo.com' } });
  // Quitar e anonimizar: a chave some junto com os nomes.
  const caio = (await api(app, 'GET', `/v1/bills/${b.id}`, { as: b.org })).body.bill.participants[2].id;
  for (const pid of [b.bruno, caio]) {
    const p = await api(app, 'POST', '/v1/payments', { as: b.guest, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: b.id, participantId: pid } });
    await api(app, 'POST', `/v1/bills/${b.id}/payments/${p.body.payment.id}/confirm`, { as: b.org });
  }
  assert.equal((await api(app, 'POST', `/v1/bills/${b.id}/anonymize`, { as: b.org })).status, 200);
  const row = await inScope(db, { kind: 'bill', tenantId: PERSONAL_TENANT, billId: b.id }, (c) => c.query('SELECT pix_key, pix_city FROM bills WHERE id = $1', [b.id]));
  assert.deepEqual(row.rows[0], { pix_key: null, pix_city: null });
});
