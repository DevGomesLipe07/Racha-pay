// Conciliação determinística e estado da conta — puro (02 § Conciliação, D1, D3, D5, D6).
//
// Por conta: TOTAL = PAGO + EM PROCESSAMENTO + ATRIBUÍDO NÃO PAGO + NÃO ATRIBUÍDO − EXCEDENTE.
// Contabilidade por participante: o excedente de um não cobre a parte de outro.

import { netPaidCents, processingCents, type PaymentSnapshot } from '../payments/state-machine.ts';

export const BILL_STATES = [
  'DRAFT',
  'OPEN',
  'PARTIALLY_PAID',
  'SETTLEMENT_PENDING',
  'SETTLED',
  'REOPENED',
  'CANCELLED',
] as const;
export type BillState = (typeof BILL_STATES)[number];

export interface ParticipantAllocation {
  participantId: string;
  dueCents: bigint;
  /** D5: parte do organizador quitada na confirmação (ORGANIZER_COLLECTS). */
  selfSettledCents: bigint;
  /** D3: devoluções manuais de excedente já registradas. */
  refundRecordedCents: bigint;
}

export interface ReconciliationInput {
  totalCents: bigint;
  allocations: readonly ParticipantAllocation[];
  payments: readonly PaymentSnapshot[];
}

export interface ParticipantReconciliation {
  participantId: string;
  dueCents: bigint;
  /** Pago confirmado líquido (pagamentos − estornos − chargebacks − devoluções) + autoquitado. */
  paidCents: bigint;
  /** Só pagamentos (sem autoquitado) — base do TPV. */
  paymentsPaidCents: bigint;
  selfSettledCents: bigint;
  processingCents: bigint;
  unpaidCents: bigint;
  excessCents: bigint;
  /** Excedente já confirmado a devolver (REFUND_DUE). */
  refundDueCents: bigint;
  /** Quanto ainda pode ser cobrado desta parte agora. */
  availableToPayCents: bigint;
}

export interface Reconciliation {
  totalCents: bigint;
  paidCents: bigint;
  processingCents: bigint;
  assignedUnpaidCents: bigint;
  unassignedCents: bigint;
  excessCents: bigint;
  refundDueCents: bigint;
  participants: ParticipantReconciliation[];
}

export class ReconciliationInvariantError extends Error {
  constructor(message: string) {
    super(`invariante da conciliação violada: ${message}`);
    this.name = 'ReconciliationInvariantError';
  }
}

const max0 = (v: bigint): bigint => (v > 0n ? v : 0n);

export function reconcile(input: ReconciliationInput): Reconciliation {
  const byParticipant = new Map<string, PaymentSnapshot[]>();
  for (const p of input.payments) {
    const list = byParticipant.get(p.participantId) ?? [];
    list.push(p);
    byParticipant.set(p.participantId, list);
  }
  const known = new Set(input.allocations.map((a) => a.participantId));
  for (const id of byParticipant.keys()) {
    if (!known.has(id)) throw new ReconciliationInvariantError(`pagamento de participante sem parte: ${id}`);
  }

  const participants = input.allocations.map((a): ParticipantReconciliation => {
    if (a.dueCents < 0n || a.selfSettledCents < 0n || a.refundRecordedCents < 0n) {
      throw new ReconciliationInvariantError(`valor negativo na parte de ${a.participantId}`);
    }
    const payments = byParticipant.get(a.participantId) ?? [];
    const paymentsPaid = payments.reduce((s, p) => s + netPaidCents(p), 0n) - a.refundRecordedCents;
    if (paymentsPaid < 0n) throw new ReconciliationInvariantError(`devolução maior que o pago para ${a.participantId}`);
    const paid = paymentsPaid + a.selfSettledCents;
    const processing = payments.reduce((s, p) => s + processingCents(p), 0n);
    return {
      participantId: a.participantId,
      dueCents: a.dueCents,
      paidCents: paid,
      paymentsPaidCents: paymentsPaid,
      selfSettledCents: a.selfSettledCents,
      processingCents: processing,
      unpaidCents: max0(a.dueCents - paid - processing),
      excessCents: max0(paid + processing - a.dueCents),
      refundDueCents: max0(paid - a.dueCents),
      availableToPayCents: max0(a.dueCents - paid - processing),
    };
  });

  const sum = (pick: (p: ParticipantReconciliation) => bigint) => participants.reduce((s, p) => s + pick(p), 0n);
  const assigned = sum((p) => p.dueCents);
  const result: Reconciliation = {
    totalCents: input.totalCents,
    paidCents: sum((p) => p.paidCents),
    processingCents: sum((p) => p.processingCents),
    assignedUnpaidCents: sum((p) => p.unpaidCents),
    unassignedCents: input.totalCents - assigned,
    excessCents: sum((p) => p.excessCents),
    refundDueCents: sum((p) => p.refundDueCents),
    participants,
  };
  assertReconciliationInvariant(result);
  return result;
}

export function assertReconciliationInvariant(r: Reconciliation): void {
  if (r.unassignedCents < 0n) throw new ReconciliationInvariantError('partes somam mais que o total');
  const rhs = r.paidCents + r.processingCents + r.assignedUnpaidCents + r.unassignedCents - r.excessCents;
  if (rhs !== r.totalCents) {
    throw new ReconciliationInvariantError(`TOTAL ${r.totalCents} ≠ PAGO + EM PROCESSAMENTO + NÃO PAGO + NÃO ATRIBUÍDO − EXCEDENTE (${rhs})`);
  }
  for (const p of r.participants) {
    if (p.paidCents + p.processingCents + p.unpaidCents - p.excessCents !== p.dueCents) {
      throw new ReconciliationInvariantError(`parte de ${p.participantId} não fecha`);
    }
  }
}

export interface BillStateInput {
  previous: BillState;
  splitConfirmed: boolean;
  cancelled: boolean;
  reconciliation: Reconciliation;
}

/** D6 — estado derivado só por regra determinística. */
export function deriveBillState(input: BillStateInput): BillState {
  if (input.cancelled) return 'CANCELLED';
  if (!input.splitConfirmed) return 'DRAFT';
  const r = input.reconciliation;
  const settled = r.unassignedCents === 0n && r.participants.every((p) => p.paidCents >= p.dueCents);
  if (settled) return 'SETTLED';
  if (input.previous === 'SETTLED' || input.previous === 'REOPENED') return 'REOPENED';
  const covered = r.unassignedCents === 0n && r.participants.every((p) => p.paidCents + p.processingCents >= p.dueCents);
  if (covered && r.processingCents > 0n) return 'SETTLEMENT_PENDING';
  if (r.participants.some((p) => p.paymentsPaidCents > 0n)) return 'PARTIALLY_PAID';
  return 'OPEN';
}
