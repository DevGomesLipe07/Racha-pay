import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveBillState,
  reconcile,
  ReconciliationInvariantError,
  type BillState,
  type ParticipantAllocation,
} from '../../src/modules/reconciliation/reconcile.ts';
import type { PaymentSnapshot, PaymentStatus } from '../../src/modules/payments/state-machine.ts';

const alloc = (participantId: string, due: number, selfSettled = 0, refundRecorded = 0): ParticipantAllocation => ({
  participantId,
  dueCents: BigInt(due),
  selfSettledCents: BigInt(selfSettled),
  refundRecordedCents: BigInt(refundRecorded),
});
let seq = 0;
const pay = (participantId: string, amount: number, status: PaymentStatus, refunded = 0): PaymentSnapshot => ({
  id: `p${++seq}`,
  participantId,
  method: 'SANDBOX',
  amountCents: BigInt(amount),
  status,
  refundedCents: BigInt(refunded),
  chargedbackCents: 0n,
  deferred: [],
});
const state = (previous: BillState, allocations: ParticipantAllocation[], payments: PaymentSnapshot[], total = 10000) =>
  deriveBillState({
    previous,
    splitConfirmed: true,
    cancelled: false,
    reconciliation: reconcile({ totalCents: BigInt(total), allocations, payments }),
  });

test('fórmula: TOTAL = PAGO + EM PROCESSAMENTO + NÃO PAGO + NÃO ATRIBUÍDO − EXCEDENTE', () => {
  const r = reconcile({
    totalCents: 10000n,
    allocations: [alloc('a', 5000), alloc('b', 3000), alloc('c', 2000)],
    payments: [pay('a', 6000, 'CONFIRMED'), pay('b', 1000, 'PENDING'), pay('b', 500, 'CONFIRMED')],
  });
  assert.equal(r.paidCents, 6500n);
  assert.equal(r.processingCents, 1000n);
  assert.equal(r.assignedUnpaidCents, 3500n);
  assert.equal(r.unassignedCents, 0n);
  assert.equal(r.excessCents, 1000n);
  assert.equal(r.paidCents + r.processingCents + r.assignedUnpaidCents + r.unassignedCents - r.excessCents, r.totalCents);
});

test('excedente de um não cobre a parte de outro', () => {
  const r = reconcile({ totalCents: 10000n, allocations: [alloc('a', 5000), alloc('b', 5000)], payments: [pay('a', 10000, 'CONFIRMED')] });
  assert.equal(r.participants[1]?.unpaidCents, 5000n);
  assert.equal(r.participants[0]?.refundDueCents, 5000n);
  assert.equal(
    deriveBillState({ previous: 'PARTIALLY_PAID', splitConfirmed: true, cancelled: false, reconciliation: r }),
    'PARTIALLY_PAID',
  );
});

test('D6: OPEN → PARTIALLY_PAID → SETTLEMENT_PENDING → SETTLED', () => {
  const allocations = [alloc('a', 5000), alloc('b', 5000)];
  assert.equal(state('OPEN', allocations, []), 'OPEN');
  assert.equal(state('OPEN', allocations, [pay('a', 5000, 'AUTHORIZED')]), 'OPEN');
  assert.equal(state('OPEN', allocations, [pay('a', 5000, 'CONFIRMED')]), 'PARTIALLY_PAID');
  assert.equal(state('PARTIALLY_PAID', allocations, [pay('a', 5000, 'CONFIRMED'), pay('b', 5000, 'PENDING')]), 'SETTLEMENT_PENDING');
  assert.equal(state('SETTLEMENT_PENDING', allocations, [pay('a', 5000, 'CONFIRMED'), pay('b', 5000, 'CONFIRMED')]), 'SETTLED');
});

test('D5: parte do organizador autoquitada não é pagamento (OPEN) e permite SETTLED', () => {
  const allocations = [alloc('org', 4000, 4000), alloc('b', 6000)];
  assert.equal(state('OPEN', allocations, []), 'OPEN');
  assert.equal(state('OPEN', allocations, [pay('b', 6000, 'CONFIRMED')]), 'SETTLED');
  const r = reconcile({ totalCents: 10000n, allocations, payments: [pay('b', 6000, 'CONFIRMED')] });
  assert.equal(r.participants[0]?.paymentsPaidCents, 0n);
});

test('D1: com valor não atribuído a conta nunca quita', () => {
  assert.equal(state('OPEN', [alloc('a', 9000)], [pay('a', 9000, 'CONFIRMED')], 10000), 'PARTIALLY_PAID');
});

test('estorno depois de quitada → REOPENED; quitar de novo → SETTLED', () => {
  const allocations = [alloc('a', 5000), alloc('b', 5000)];
  assert.equal(state('SETTLED', allocations, [pay('a', 5000, 'CONFIRMED'), pay('b', 5000, 'CONFIRMED', 1000)]), 'REOPENED');
  assert.equal(
    state('REOPENED', allocations, [pay('a', 5000, 'CONFIRMED'), pay('b', 5000, 'CONFIRMED', 1000), pay('b', 1000, 'CONFIRMED')]),
    'SETTLED',
  );
});

test('D3: devolução manual zera o REFUND_DUE sem desfazer a quitação', () => {
  const r = reconcile({ totalCents: 5000n, allocations: [alloc('a', 5000, 0, 700)], payments: [pay('a', 5700, 'CONFIRMED')] });
  assert.equal(r.refundDueCents, 0n);
  assert.equal(r.participants[0]?.paidCents, 5000n);
  assert.throws(
    () => reconcile({ totalCents: 5000n, allocations: [alloc('a', 5000, 0, 9000)], payments: [pay('a', 5000, 'CONFIRMED')] }),
    ReconciliationInvariantError,
  );
});

test('saldo disponível para pagar desconta o que está em processamento (reserva)', () => {
  const r = reconcile({ totalCents: 5000n, allocations: [alloc('a', 5000)], payments: [pay('a', 3000, 'PENDING')] });
  assert.equal(r.participants[0]?.availableToPayCents, 2000n);
});

test('estados terminais e rascunho', () => {
  const reconciliation = reconcile({ totalCents: 0n, allocations: [], payments: [] });
  assert.equal(deriveBillState({ previous: 'OPEN', splitConfirmed: true, cancelled: true, reconciliation }), 'CANCELLED');
  assert.equal(deriveBillState({ previous: 'DRAFT', splitConfirmed: false, cancelled: false, reconciliation }), 'DRAFT');
});

test('invariante: partes somando mais que o total abortam', () => {
  assert.throws(() => reconcile({ totalCents: 100n, allocations: [alloc('a', 101)], payments: [] }), ReconciliationInvariantError);
  assert.throws(
    () => reconcile({ totalCents: 100n, allocations: [alloc('a', 100)], payments: [pay('x', 1, 'CONFIRMED')] }),
    ReconciliationInvariantError,
  );
});
