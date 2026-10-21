import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inScope, openTestDb, PERSONAL_TENANT, resetDatabase, type TestDb } from './helpers.ts';
import { api, startApp, type TestApp } from './http.ts';
import { signPayload } from '../../src/modules/payments/providers.ts';
import { DEV_SECRETS } from '../../src/config.ts';

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

interface Bill {
  id: string;
  org: { organizer: string };
  guest: { share: string };
  ana: string;
  bruno: string;
  caio: string;
}

/** Conta confirmada: R$ 300,00 igual entre Ana (organizadora, já quitada), Bruno e Caio. */
async function confirmedBill(): Promise<Bill> {
  const r = await api(app, 'POST', '/v1/bills', { body: { kind: 'OTHER', title: 'Viagem', organizerName: 'Ana', participants: ['Bruno', 'Caio'] } });
  const id = r.body.bill.id;
  const org = { organizer: r.body.organizerToken };
  const [ana, bruno, caio] = r.body.bill.participants.map((p: { id: string }) => p.id);
  await api(app, 'POST', `/v1/bills/${id}/items`, { as: org, body: { description: 'Hospedagem', unitPriceCents: 30000 } });
  const ok = await api(app, 'POST', `/v1/bills/${id}/splits`, { as: org, body: { expectedTotalCents: 30000 } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.bill.state, 'OPEN');
  return { id, org, guest: { share: r.body.shareToken }, ana, bruno, caio };
}

const pay = (b: Bill, participantId: string, opts: { method?: 'MANUAL' | 'SANDBOX'; amountCents?: number; key?: string; as?: object } = {}) =>
  api(app, 'POST', '/v1/payments', {
    as: (opts.as ?? b.guest) as never,
    headers: { 'idempotency-key': opts.key ?? `k-${randomUUID()}` },
    body: { billId: b.id, participantId, method: opts.method ?? 'MANUAL', ...(opts.amountCents ? { amountCents: opts.amountCents } : {}) },
  });

async function webhook(body: object, opts: { secret?: string; at?: Date; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  const t = Math.floor((opts.at ?? app.clock.now()).getTime() / 1000);
  const signature = opts.signature ?? signPayload(opts.secret ?? DEV_SECRETS.SANDBOX_WEBHOOK_SECRET, raw, t);
  const res = await fetch(`${app.base}/v1/webhooks/payments/sandbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sandbox-signature': signature },
    body: raw,
  });
  return { status: res.status, body: (await res.json()) as any };
}

const state = async (b: Bill) => (await api(app, 'GET', `/v1/bills/${b.id}`, { as: b.org })).body.bill;
const ledgerOf = async (b: Bill) => (await api(app, 'GET', `/v1/bills/${b.id}/ledger`, { as: b.org })).body;
const cases = (b: Bill) =>
  inScope(db, { kind: 'bill', tenantId: PERSONAL_TENANT, billId: b.id }, async (c) => (await c.query('SELECT kind, status FROM cbr_cases WHERE bill_id = $1 ORDER BY created_at', [b.id])).rows);

test('manual: convidado declara, organizador confirma → PARTIALLY_PAID → SETTLED; convidado não confirma', async () => {
  const b = await confirmedBill();
  const p1 = await pay(b, b.bruno);
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  assert.equal(p1.body.payment.status, 'PENDING');
  assert.equal(p1.body.payment.amountCents, 10000);
  assert.equal(p1.body.bill.state, 'OPEN');

  const guestConfirm = await api(app, 'POST', `/v1/bills/${b.id}/payments/${p1.body.payment.id}/confirm`, { as: b.guest });
  assert.equal(guestConfirm.status, 403);

  const c1 = await api(app, 'POST', `/v1/bills/${b.id}/payments/${p1.body.payment.id}/confirm`, { as: b.org });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c1.body.bill.state, 'PARTIALLY_PAID');
  assert.equal((await api(app, 'POST', `/v1/bills/${b.id}/payments/${p1.body.payment.id}/confirm`, { as: b.org })).body.error.code, 'PAYMENT_NOT_PENDING');

  const p2 = await pay(b, b.caio);
  assert.equal((await state(b)).state, 'SETTLEMENT_PENDING');
  const c2 = await api(app, 'POST', `/v1/bills/${b.id}/payments/${p2.body.payment.id}/confirm`, { as: b.org });
  assert.equal(c2.body.bill.state, 'SETTLED');
  assert.equal(c2.body.bill.reconciliation.assignedUnpaidCents, 0);

  const l = await ledgerOf(b);
  assert.equal(l.verification.valid, true);
  assert.equal(l.reconstruction.consistent, true);
  assert.equal(l.entries.filter((e: { type: string }) => e.type === 'PAYMENT_CONFIRMED').length, 2);
  assert.equal((await pay(b, b.bruno)).body.error.code, 'BILL_SETTLED');
});

test('organizador recusa pagamento manual → REJECTED + caso; o saldo volta a ficar disponível', async () => {
  const b = await confirmedBill();
  const p = await pay(b, b.bruno);
  const r = await api(app, 'POST', `/v1/bills/${b.id}/payments/${p.body.payment.id}/reject`, { as: b.org });
  assert.equal(r.status, 200);
  assert.deepEqual(await cases(b), [{ kind: 'MANUAL_PAYMENT_REJECTED', status: 'OPEN' }]);
  assert.equal((await pay(b, b.bruno)).status, 201);
});

test('D12: mesma chave = mesmo pagamento; corpo diferente = 422; sem chave = 400', async () => {
  const b = await confirmedBill();
  const first = await pay(b, b.bruno, { key: 'chave-fixa-0001' });
  const again = await pay(b, b.bruno, { key: 'chave-fixa-0001' });
  assert.equal(again.status, 201);
  assert.equal(again.body.payment.id, first.body.payment.id);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal((await pay(b, b.caio, { key: 'chave-fixa-0001' })).body.error.code, 'IDEMPOTENCY_MISMATCH');
  const noKey = await api(app, 'POST', '/v1/payments', { as: b.guest, body: { billId: b.id, participantId: b.bruno } });
  assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  // Erro de regra também é a resposta daquela chave.
  const over = await pay(b, b.caio, { key: 'chave-fixa-0002', amountCents: 999999 });
  const overAgain = await pay(b, b.caio, { key: 'chave-fixa-0002', amountCents: 999999 });
  assert.equal(over.status, 409);
  assert.equal(overAgain.status, 409);
  assert.equal(overAgain.headers.get('idempotent-replayed'), 'true');
});

test('concorrência: 10 abas pagando a mesma parte geram UMA reserva; 10 repetições da mesma chave, um pagamento', async () => {
  const b = await confirmedBill();
  const tabs = await Promise.all(Array.from({ length: 10 }, () => pay(b, b.bruno)));
  const statuses = tabs.map((t) => t.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
  assert.ok(tabs.filter((t) => t.status === 409).every((t) => t.body.error.code === 'NOTHING_TO_PAY'));

  const same = await Promise.all(Array.from({ length: 10 }, () => pay(b, b.caio, { key: 'mesma-chave-concorrente' })));
  const ids = new Set(same.map((s) => s.body.payment?.id));
  assert.equal(ids.size, 1, JSON.stringify(same.map((s) => [s.status, s.body.error?.code])));
  const rows = await inScope(db, { kind: 'bill', tenantId: PERSONAL_TENANT, billId: b.id }, (c) =>
    c.query("SELECT count(*)::int AS n FROM payments WHERE bill_id = $1 AND participant_id = $2", [b.id, b.caio]),
  );
  assert.equal(rows.rows[0].n, 1);
});

test('sandbox: webhook assinado confirma; assinatura errada, expirada e referência desconhecida são recusadas; duplicado não aplica duas vezes', async () => {
  const b = await confirmedBill();
  const p = await pay(b, b.bruno, { method: 'SANDBOX' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.payment.status, 'PENDING');
  const reference = p.body.payment.sandbox.reference;
  assert.match(reference, /^sbx_[0-9a-f]{24}$/);
  assert.equal(p.body.payment.sandbox.environment, 'SANDBOX');

  const event = { eventId: 'evt-001', reference, kind: 'CONFIRMED' };
  assert.equal((await webhook(event, { secret: 'segredo-errado-1234567890' })).status, 401);
  const old = await webhook(event, { at: new Date(app.clock.now().getTime() - 6 * 60_000) });
  assert.equal(old.status, 401);
  assert.equal(old.body.error.code, 'SIGNATURE_EXPIRED');
  assert.equal((await webhook({ ...event, reference: `sbx_${'0'.repeat(24)}` })).status, 404);

  const ok = await webhook(event);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { received: true, duplicate: false, outcome: 'APPLIED' });
  const dup = await webhook(event);
  assert.deepEqual(dup.body, { received: true, duplicate: true, outcome: 'DUPLICATE' });
  const l = await ledgerOf(b);
  assert.equal(l.entries.filter((e: { type: string }) => e.type === 'PAYMENT_CONFIRMED').length, 1);
  assert.equal((await state(b)).state, 'PARTIALLY_PAID');
});

test('fora de ordem: estorno antes da confirmação é adiado e reaplicado (OUT_OF_ORDER_EVENT)', async () => {
  const b = await confirmedBill();
  const p = await pay(b, b.bruno, { method: 'SANDBOX' });
  const reference = p.body.payment.sandbox.reference;
  const deferred = await webhook({ eventId: 'ooo-refund', reference, kind: 'REFUNDED', amountCents: 2500 });
  assert.equal(deferred.body.outcome, 'DEFERRED');
  await webhook({ eventId: 'ooo-confirm', reference, kind: 'CONFIRMED' });
  const bill = await state(b);
  const payment = bill.payments.find((x: { id: string }) => x.id === p.body.payment.id);
  assert.equal(payment.netPaidCents, 7500);
  assert.equal(payment.refundedCents, 2500);
  assert.deepEqual((await cases(b)).map((c: { kind: string }) => c.kind), ['OUT_OF_ORDER_EVENT']);
  const types = (await ledgerOf(b)).entries.map((e: { type: string }) => e.type);
  assert.ok(types.indexOf('PAYMENT_REFUNDED') > types.indexOf('PAYMENT_CONFIRMED'));
});

test('expiração pelo worker e confirmação tardia (LATE_CONFIRMATION); excedente vira REFUND_DUE + OVERPAYMENT; D3 devolução manual resolve', async () => {
  const b = await confirmedBill();
  const late = await pay(b, b.bruno, { method: 'SANDBOX' });
  app.clock.advance(31 * 60_000);
  const run = await app.runExpiry();
  assert.ok(run.expired >= 1);
  let bill = await state(b);
  assert.equal(bill.payments.find((x: { id: string }) => x.id === late.body.payment.id).status, 'EXPIRED');

  // Bruno paga de novo (a reserva foi liberada) e a confirmação antiga chega atrasada.
  const fresh = await pay(b, b.bruno, { method: 'SANDBOX' });
  await webhook({ eventId: 'fresh-ok', reference: fresh.body.payment.sandbox.reference, kind: 'CONFIRMED' });
  await webhook({ eventId: 'late-ok', reference: late.body.payment.sandbox.reference, kind: 'CONFIRMED' });
  bill = await state(b);
  const bruno = bill.participants.find((p: { id: string }) => p.id === b.bruno);
  assert.equal(bruno.balance.refundDueCents, 10000);
  const kinds = (await cases(b)).map((c: { kind: string }) => c.kind);
  assert.ok(kinds.includes('LATE_CONFIRMATION'));
  assert.ok(kinds.includes('OVERPAYMENT'));
  // O excedente do Bruno não paga a parte do Caio.
  assert.equal(bill.participants.find((p: { id: string }) => p.id === b.caio).balance.unpaidCents, 10000);
  assert.equal(bill.state, 'PARTIALLY_PAID');

  const tooMuch = await api(app, 'POST', '/v1/refunds', { as: b.org, body: { kind: 'MANUAL_RECORD', billId: b.id, participantId: b.bruno, amountCents: 10001 } });
  assert.equal(tooMuch.body.error.code, 'REFUND_EXCEEDS_DUE');
  const devolvi = await api(app, 'POST', '/v1/refunds', { as: b.org, body: { kind: 'MANUAL_RECORD', billId: b.id, participantId: b.bruno, amountCents: 10000 } });
  assert.equal(devolvi.status, 201, JSON.stringify(devolvi.body));
  assert.equal(devolvi.body.refund.resolvedCases, 1);
  assert.equal(devolvi.body.bill.participants.find((p: { id: string }) => p.id === b.bruno).balance.refundDueCents, 0);
  const l = await ledgerOf(b);
  assert.equal(l.reconstruction.consistent, true, JSON.stringify(l.reconstruction));
  assert.ok(l.entries.some((e: { type: string }) => e.type === 'REFUND_RECORDED'));
});

test('estorno e chargeback depois de quitada → REOPENED (+ casos); quitar de novo → SETTLED', async () => {
  const b = await confirmedBill();
  const pb = await pay(b, b.bruno, { method: 'SANDBOX' });
  const pc = await pay(b, b.caio, { method: 'SANDBOX' });
  await webhook({ eventId: 's-b', reference: pb.body.payment.sandbox.reference, kind: 'CONFIRMED' });
  await webhook({ eventId: 's-c', reference: pc.body.payment.sandbox.reference, kind: 'CONFIRMED' });
  assert.equal((await state(b)).state, 'SETTLED');

  const refund = await api(app, 'POST', '/v1/refunds', { as: b.org, body: { kind: 'PROVIDER', billId: b.id, paymentId: pb.body.payment.id, amountCents: 3000 } });
  assert.equal(refund.status, 201, JSON.stringify(refund.body));
  assert.equal(refund.body.bill.state, 'REOPENED');
  assert.ok((await cases(b)).some((c: { kind: string }) => c.kind === 'REFUND_AFTER_SETTLEMENT'));

  const topUp = await pay(b, b.bruno, { method: 'SANDBOX' });
  assert.equal(topUp.body.payment.amountCents, 3000);
  await webhook({ eventId: 's-b2', reference: topUp.body.payment.sandbox.reference, kind: 'CONFIRMED' });
  assert.equal((await state(b)).state, 'SETTLED');

  const cb = await webhook({ eventId: 'cb-c', reference: pc.body.payment.sandbox.reference, kind: 'CHARGEDBACK' });
  assert.equal(cb.body.outcome, 'APPLIED');
  assert.equal((await state(b)).state, 'REOPENED');
  assert.ok((await cases(b)).some((c: { kind: string }) => c.kind === 'CHARGEBACK'));
  const l = await ledgerOf(b);
  assert.equal(l.verification.valid, true);
  assert.equal(l.reconstruction.consistent, true);
});

test('regras de criação e bloqueios: rascunho, valor acima do saldo, organizador já quitado, destravar/cancelar com pagamento', async () => {
  const draft = await api(app, 'POST', '/v1/bills', { body: { title: 'Rascunho', organizerName: 'Ana', participants: ['Bruno'] } });
  const d = draft.body.bill;
  const r = await api(app, 'POST', '/v1/payments', {
    as: { share: draft.body.shareToken },
    headers: { 'idempotency-key': `k-${randomUUID()}` },
    body: { billId: d.id, participantId: d.participants[1].id },
  });
  assert.equal(r.body.error.code, 'SPLIT_NOT_CONFIRMED');

  const b = await confirmedBill();
  assert.equal((await pay(b, b.bruno, { amountCents: 10001 })).body.error.code, 'AMOUNT_EXCEEDS_BALANCE');
  assert.equal((await pay(b, b.ana)).body.error.code, 'NOTHING_TO_PAY');
  const partial = await pay(b, b.bruno, { amountCents: 4000 });
  assert.equal(partial.status, 201);
  assert.equal((await pay(b, b.bruno)).body.payment.amountCents, 6000);
  assert.equal((await api(app, 'POST', `/v1/bills/${b.id}/splits/unlock`, { as: b.org })).body.error.code, 'HAS_PAYMENTS');
  assert.equal((await api(app, 'POST', `/v1/bills/${b.id}/cancel`, { as: b.org, body: {} })).body.error.code, 'HAS_PAYMENTS');
  const manualRefund = await api(app, 'POST', '/v1/refunds', { as: b.org, body: { kind: 'PROVIDER', billId: b.id, paymentId: partial.body.payment.id } });
  assert.equal(manualRefund.body.error.code, 'USE_MANUAL_REFUND_RECORD');
});

test('simulador do sandbox passa pelo mesmo caminho do webhook real', async () => {
  const b = await confirmedBill();
  const p = await pay(b, b.bruno, { method: 'SANDBOX' });
  const sim = await api(app, 'POST', `/v1/bills/${b.id}/payments/${p.body.payment.id}/simulate`, { as: b.guest, body: { kind: 'CONFIRMED', eventId: 'sim-1' } });
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.equal(sim.body.outcome, 'APPLIED');
  assert.equal(sim.body.bill.state, 'PARTIALLY_PAID');
  const again = await api(app, 'POST', `/v1/bills/${b.id}/payments/${p.body.payment.id}/simulate`, { as: b.guest, body: { kind: 'CONFIRMED', eventId: 'sim-1' } });
  assert.equal(again.body.duplicate, true);
  const events = await inScope(db, { kind: 'bill', tenantId: PERSONAL_TENANT, billId: b.id }, (c) =>
    c.query('SELECT event_id, outcome FROM provider_events WHERE bill_id = $1', [b.id]),
  );
  assert.deepEqual(events.rows, [{ event_id: 'sim-1', outcome: 'APPLIED' }]);
});
