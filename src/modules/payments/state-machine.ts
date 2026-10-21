// Máquina de estados do pagamento — pura (02 § Pagamentos).
//
// - AUTHORIZED não quita; só CONFIRMED conta como pago.
// - Eventos de provedor são monotônicos: confirmação depois de falha/expiração é aceita (o dinheiro
//   entrou) e gera LATE_CONFIRMATION; falha depois de confirmação é ignorada; estorno/chargeback antes
//   da confirmação é adiado e reaplicado depois (OUT_OF_ORDER_EVENT).

import type { LedgerEventType } from '../ledger/chain.ts';

export const PAYMENT_METHODS = ['MANUAL', 'SANDBOX'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number] | `PSP:${string}`;

export const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'AUTHORIZED',
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
  'REJECTED',
  'REFUNDED',
  'CHARGEDBACK',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Em processamento: reserva saldo da parte, ainda não é pago. */
export const PROCESSING_STATUSES: readonly PaymentStatus[] = ['CREATED', 'PENDING', 'AUTHORIZED'];
/** Já foi confirmado alguma vez (o valor líquido conta como pago). */
export const CONFIRMED_STATUSES: readonly PaymentStatus[] = ['CONFIRMED', 'REFUNDED', 'CHARGEDBACK'];
const FAILED_STATUSES: readonly PaymentStatus[] = ['FAILED', 'EXPIRED', 'REJECTED'];

export const PAYMENT_EVENT_KINDS = [
  'PENDING',
  'AUTHORIZED',
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
  'REJECTED',
  'REFUNDED',
  'CHARGEDBACK',
] as const;
export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number];

export interface PaymentEvent {
  /** Identificador do evento na origem (provedor, organizador, worker) — deduplicação fica no serviço. */
  eventId: string;
  kind: PaymentEventKind;
  /** Só para REFUNDED/CHARGEDBACK; ausente = valor líquido restante inteiro. */
  amountCents?: bigint;
}

export interface PaymentSnapshot {
  id: string;
  participantId: string;
  method: PaymentMethod;
  amountCents: bigint;
  status: PaymentStatus;
  refundedCents: bigint;
  chargedbackCents: bigint;
  /** Estornos/chargebacks recebidos antes da confirmação, na ordem de chegada. */
  deferred: readonly PaymentEvent[];
}

export type CbrCaseKind = 'LATE_CONFIRMATION' | 'OUT_OF_ORDER_EVENT' | 'CHARGEBACK' | 'MANUAL_PAYMENT_REJECTED';

export interface PaymentEffect {
  ledger: { type: LedgerEventType; amountCents: bigint; eventId: string }[];
  cases: { kind: CbrCaseKind; eventId: string }[];
}

export type PaymentOutcome = 'APPLIED' | 'IGNORED' | 'DEFERRED';

export interface PaymentTransition {
  payment: PaymentSnapshot;
  outcome: PaymentOutcome;
  effects: PaymentEffect;
}

export class PaymentEventError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentEventError';
    this.code = code;
  }
}

export function netPaidCents(p: PaymentSnapshot): bigint {
  return CONFIRMED_STATUSES.includes(p.status) ? p.amountCents - p.refundedCents - p.chargedbackCents : 0n;
}

export function processingCents(p: PaymentSnapshot): bigint {
  return PROCESSING_STATUSES.includes(p.status) ? p.amountCents : 0n;
}

const LEDGER_FOR: Record<PaymentEventKind, LedgerEventType> = {
  PENDING: 'PAYMENT_PENDING',
  AUTHORIZED: 'PAYMENT_AUTHORIZED',
  CONFIRMED: 'PAYMENT_CONFIRMED',
  FAILED: 'PAYMENT_FAILED',
  EXPIRED: 'PAYMENT_EXPIRED',
  REJECTED: 'PAYMENT_REJECTED',
  REFUNDED: 'PAYMENT_REFUNDED',
  CHARGEDBACK: 'PAYMENT_CHARGEDBACK',
};

function emptyEffect(): PaymentEffect {
  return { ledger: [], cases: [] };
}

export function applyPaymentEvent(payment: PaymentSnapshot, event: PaymentEvent): PaymentTransition {
  const effects = emptyEffect();
  const p: PaymentSnapshot = { ...payment, deferred: [...payment.deferred] };
  const ignored = (): PaymentTransition => ({ payment, outcome: 'IGNORED', effects: emptyEffect() });
  const record = (kind: PaymentEventKind, amount: bigint) =>
    effects.ledger.push({ type: LEDGER_FOR[kind], amountCents: amount, eventId: event.eventId });

  switch (event.kind) {
    case 'PENDING':
      if (p.status !== 'CREATED') return ignored();
      p.status = 'PENDING';
      record('PENDING', p.amountCents);
      return { payment: p, outcome: 'APPLIED', effects };

    case 'AUTHORIZED':
      if (p.status !== 'CREATED' && p.status !== 'PENDING') return ignored();
      p.status = 'AUTHORIZED';
      record('AUTHORIZED', p.amountCents);
      return { payment: p, outcome: 'APPLIED', effects };

    case 'CONFIRMED': {
      if (CONFIRMED_STATUSES.includes(p.status)) return ignored();
      if (FAILED_STATUSES.includes(p.status)) {
        if (p.status === 'REJECTED' && p.method === 'MANUAL') return ignored(); // organizador recusou; não há dinheiro
        effects.cases.push({ kind: 'LATE_CONFIRMATION', eventId: event.eventId });
      }
      p.status = 'CONFIRMED';
      record('CONFIRMED', p.amountCents);
      // Reaplica estornos/chargebacks adiados, na ordem de chegada.
      const pending = p.deferred;
      p.deferred = [];
      let current: PaymentSnapshot = p;
      for (const d of pending) {
        // A confirmação nunca é bloqueada por um adiado inconsistente: limita ao líquido restante.
        const net = netPaidCents(current);
        const amountCents = d.amountCents !== undefined && d.amountCents > net ? net : d.amountCents;
        if (net === 0n) break;
        const t = applyPaymentEvent(current, amountCents === undefined ? d : { ...d, amountCents });
        current = t.payment;
        effects.ledger.push(...t.effects.ledger);
        effects.cases.push(...t.effects.cases);
      }
      return { payment: current, outcome: 'APPLIED', effects };
    }

    case 'FAILED':
    case 'EXPIRED':
    case 'REJECTED':
      if (!PROCESSING_STATUSES.includes(p.status)) return ignored();
      p.status = event.kind;
      record(event.kind, p.amountCents);
      if (event.kind === 'REJECTED' && p.method === 'MANUAL') {
        effects.cases.push({ kind: 'MANUAL_PAYMENT_REJECTED', eventId: event.eventId });
      }
      return { payment: p, outcome: 'APPLIED', effects };

    case 'REFUNDED':
    case 'CHARGEDBACK': {
      if (!CONFIRMED_STATUSES.includes(p.status)) {
        if (p.deferred.some((d) => d.eventId === event.eventId)) return ignored();
        p.deferred = [...p.deferred, event];
        effects.cases.push({ kind: 'OUT_OF_ORDER_EVENT', eventId: event.eventId });
        return { payment: p, outcome: 'DEFERRED', effects };
      }
      const net = netPaidCents(p);
      if (net === 0n) return ignored();
      const amount = event.amountCents ?? net;
      if (amount <= 0n) throw new PaymentEventError('INVALID_AMOUNT', 'valor de estorno/chargeback deve ser positivo');
      if (amount > net) throw new PaymentEventError('AMOUNT_EXCEEDS_NET', 'valor maior que o líquido do pagamento');
      if (event.kind === 'REFUNDED') {
        p.refundedCents += amount;
        if (netPaidCents(p) === 0n) p.status = 'REFUNDED';
      } else {
        p.chargedbackCents += amount;
        if (netPaidCents(p) === 0n) p.status = 'CHARGEDBACK';
        effects.cases.push({ kind: 'CHARGEBACK', eventId: event.eventId });
      }
      record(event.kind, amount);
      return { payment: p, outcome: 'APPLIED', effects };
    }
  }
}
