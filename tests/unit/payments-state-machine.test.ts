import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPaymentEvent,
  netPaidCents,
  PaymentEventError,
  processingCents,
  type PaymentEvent,
  type PaymentSnapshot,
} from '../../src/modules/payments/state-machine.ts';

const payment = (over: Partial<PaymentSnapshot> = {}): PaymentSnapshot => ({
  id: 'pay-1',
  participantId: 'b',
  method: 'SANDBOX',
  amountCents: 5000n,
  status: 'PENDING',
  refundedCents: 0n,
  chargedbackCents: 0n,
  deferred: [],
  ...over,
});
let n = 0;
const ev = (kind: PaymentEvent['kind'], amountCents?: bigint): PaymentEvent =>
  amountCents === undefined ? { eventId: `e${++n}`, kind } : { eventId: `e${++n}`, kind, amountCents };

function run(start: PaymentSnapshot, events: PaymentEvent[]) {
  let p = start;
  const ledger: string[] = [];
  const cases: string[] = [];
  const outcomes: string[] = [];
  for (const e of events) {
    const t = applyPaymentEvent(p, e);
    p = t.payment;
    outcomes.push(t.outcome);
    ledger.push(...t.effects.ledger.map((l) => `${l.type}:${l.amountCents}`));
    cases.push(...t.effects.cases.map((c) => c.kind));
  }
  return { p, ledger, cases, outcomes };
}

test('AUTHORIZED não quita; só CONFIRMED conta como pago', () => {
  const a = run(payment(), [ev('AUTHORIZED')]);
  assert.equal(a.p.status, 'AUTHORIZED');
  assert.equal(netPaidCents(a.p), 0n);
  assert.equal(processingCents(a.p), 5000n);
  const c = run(a.p, [ev('CONFIRMED')]);
  assert.equal(netPaidCents(c.p), 5000n);
  assert.equal(processingCents(c.p), 0n);
});

test('confirmação duplicada é ignorada', () => {
  const r = run(payment(), [ev('CONFIRMED'), ev('CONFIRMED')]);
  assert.deepEqual(r.outcomes, ['APPLIED', 'IGNORED']);
  assert.deepEqual(r.ledger, ['PAYMENT_CONFIRMED:5000']);
});

test('confirmação depois de falha/expiração é aceita e vira LATE_CONFIRMATION', () => {
  for (const kind of ['FAILED', 'EXPIRED'] as const) {
    const r = run(payment(), [ev(kind), ev('CONFIRMED')]);
    assert.equal(r.p.status, 'CONFIRMED');
    assert.deepEqual(r.cases, ['LATE_CONFIRMATION']);
  }
});

test('falha depois de confirmação é ignorada', () => {
  const r = run(payment(), [ev('CONFIRMED'), ev('FAILED'), ev('EXPIRED')]);
  assert.equal(r.p.status, 'CONFIRMED');
  assert.deepEqual(r.outcomes, ['APPLIED', 'IGNORED', 'IGNORED']);
});

test('estorno antes da confirmação é adiado e reaplicado depois (OUT_OF_ORDER_EVENT)', () => {
  const r = run(payment(), [ev('REFUNDED', 2000n), ev('CONFIRMED')]);
  assert.deepEqual(r.outcomes, ['DEFERRED', 'APPLIED']);
  assert.deepEqual(r.ledger, ['PAYMENT_CONFIRMED:5000', 'PAYMENT_REFUNDED:2000']);
  assert.deepEqual(r.cases, ['OUT_OF_ORDER_EVENT']);
  assert.equal(netPaidCents(r.p), 3000n);
  assert.equal(r.p.deferred.length, 0);
});

test('estorno parcial mantém CONFIRMED; total vira REFUNDED', () => {
  const r = run(payment(), [ev('CONFIRMED'), ev('REFUNDED', 1000n)]);
  assert.equal(r.p.status, 'CONFIRMED');
  assert.equal(netPaidCents(r.p), 4000n);
  const t = run(r.p, [ev('REFUNDED')]);
  assert.equal(t.p.status, 'REFUNDED');
  assert.equal(netPaidCents(t.p), 0n);
  assert.deepEqual(t.ledger, ['PAYMENT_REFUNDED:4000']);
});

test('chargeback gera caso CHARGEBACK e zera o líquido', () => {
  const r = run(payment(), [ev('CONFIRMED'), ev('CHARGEDBACK')]);
  assert.equal(r.p.status, 'CHARGEDBACK');
  assert.deepEqual(r.cases, ['CHARGEBACK']);
  assert.equal(netPaidCents(r.p), 0n);
});

test('estorno maior que o líquido é recusado', () => {
  const confirmed = run(payment(), [ev('CONFIRMED')]).p;
  assert.throws(() => applyPaymentEvent(confirmed, ev('REFUNDED', 5001n)), PaymentEventError);
  assert.throws(() => applyPaymentEvent(confirmed, ev('REFUNDED', 0n)), PaymentEventError);
});

test('adiado inconsistente não bloqueia a confirmação (limitado ao líquido)', () => {
  const r = run(payment(), [ev('REFUNDED', 9000n), ev('CONFIRMED')]);
  assert.equal(r.p.status, 'REFUNDED');
  assert.deepEqual(r.ledger, ['PAYMENT_CONFIRMED:5000', 'PAYMENT_REFUNDED:5000']);
});

test('manual: organizador recusa → REJECTED + caso; confirmação posterior é ignorada', () => {
  const r = run(payment({ method: 'MANUAL' }), [ev('REJECTED'), ev('CONFIRMED')]);
  assert.equal(r.p.status, 'REJECTED');
  assert.deepEqual(r.cases, ['MANUAL_PAYMENT_REJECTED']);
  assert.deepEqual(r.outcomes, ['APPLIED', 'IGNORED']);
});

test('evento não altera o snapshot original (puro)', () => {
  const original = payment();
  applyPaymentEvent(original, ev('CONFIRMED'));
  applyPaymentEvent(original, ev('REFUNDED', 1n));
  assert.equal(original.status, 'PENDING');
  assert.equal(original.deferred.length, 0);
});
