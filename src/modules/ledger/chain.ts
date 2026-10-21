// Ledger append-only encadeado por hash — parte pura (cálculo, verificação, reconstrução).
// A persistência e as triggers que proíbem UPDATE/DELETE/TRUNCATE ficam na camada de banco.

import { canonicalJson, type CanonicalValue } from '../../infra/crypto/canonical-json.ts';
import { sha256Hex } from '../../infra/crypto/hash.ts';

/** D13 — lista fechada. Tipo novo exige nova versão desta lista (e de 02 § D13). */
export const LEDGER_EVENT_TYPES = [
  'BILL_CREATED',
  'SPLIT_CONFIRMED',
  'SPLIT_COMPLEMENTED',
  'SPLIT_UNLOCKED',
  'ORGANIZER_SHARE_SELF_SETTLED',
  'PAYMENT_CREATED',
  'PAYMENT_PENDING',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_FAILED',
  'PAYMENT_EXPIRED',
  'PAYMENT_REJECTED',
  'PAYMENT_REFUNDED',
  'PAYMENT_CHARGEDBACK',
  'REFUND_RECORDED',
  'BILL_STATE_CHANGED',
  'BILL_CANCELLED',
  'ERP_ACKNOWLEDGED',
] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

export const ACTOR_TYPES = ['HUMAN', 'SYSTEM', 'AI'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface LedgerActor {
  type: ActorType;
  /** Quem agiu: participante, chave de API, X-Actor-Id… (nunca dado pessoal além do necessário). */
  id: string;
}

export const GENESIS_HASH = '0'.repeat(64);
const HASH_VERSION = 1;

export interface LedgerEntryDraft {
  billId: string;
  type: LedgerEventType;
  payload: { readonly [key: string]: CanonicalValue | undefined };
  actor: LedgerActor;
  correlationId: string;
  /** ISO 8601 em UTC, gerado pelo relógio injetado. */
  occurredAt: string;
}

export interface LedgerEntry extends LedgerEntryDraft {
  seq: number;
  prevHash: string;
  entryHash: string;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export function computeEntryHash(entry: Omit<LedgerEntry, 'entryHash'>): string {
  return sha256Hex(
    canonicalJson({
      v: HASH_VERSION,
      billId: entry.billId,
      seq: entry.seq,
      type: entry.type,
      payload: entry.payload,
      actor: { type: entry.actor.type, id: entry.actor.id },
      correlationId: entry.correlationId,
      occurredAt: entry.occurredAt,
      prevHash: entry.prevHash,
    }),
  );
}

/** Próxima entrada da cadeia, a partir da última (ou do gênese). */
export function chainNext(previous: Pick<LedgerEntry, 'seq' | 'entryHash'> | undefined, draft: LedgerEntryDraft): LedgerEntry {
  if (!LEDGER_EVENT_TYPES.includes(draft.type)) throw new LedgerError(`tipo de evento desconhecido: ${draft.type}`);
  if (!ACTOR_TYPES.includes(draft.actor.type)) throw new LedgerError(`tipo de ator desconhecido: ${draft.actor.type}`);
  if (Number.isNaN(Date.parse(draft.occurredAt))) throw new LedgerError('occurredAt inválido');
  const seq = previous ? previous.seq + 1 : 1;
  const prevHash = previous ? previous.entryHash : GENESIS_HASH;
  const partial = { ...draft, seq, prevHash };
  return { ...partial, entryHash: computeEntryHash(partial) };
}

export interface ChainVerification {
  valid: boolean;
  entries: number;
  /** Primeira entrada com problema (seq), se houver. */
  brokenAt?: number;
  reason?: string;
}

export function verifyChain(entries: readonly LedgerEntry[]): ChainVerification {
  let prev: LedgerEntry | undefined;
  for (const e of entries) {
    const expectedSeq = prev ? prev.seq + 1 : 1;
    if (e.seq !== expectedSeq) return { valid: false, entries: entries.length, brokenAt: e.seq, reason: 'sequência quebrada' };
    if (prev && e.billId !== prev.billId) return { valid: false, entries: entries.length, brokenAt: e.seq, reason: 'conta diferente na cadeia' };
    const expectedPrev = prev ? prev.entryHash : GENESIS_HASH;
    if (e.prevHash !== expectedPrev) return { valid: false, entries: entries.length, brokenAt: e.seq, reason: 'prev_hash não confere' };
    if (computeEntryHash(e) !== e.entryHash) return { valid: false, entries: entries.length, brokenAt: e.seq, reason: 'entry_hash não confere (conteúdo adulterado)' };
    prev = e;
  }
  return { valid: true, entries: entries.length };
}

// ---------------------------------------------------------------------------
// Reconstrução de devido/pago só a partir do ledger (02 § Ledger).

export interface ReconstructedParticipant {
  dueCents: bigint;
  /** Pagamentos confirmados líquidos de estorno/chargeback. */
  paidCents: bigint;
  /** Parte do organizador quitada na confirmação (D5) — não é pagamento. */
  selfSettledCents: bigint;
  /** Devoluções manuais registradas (D3). */
  refundRecordedCents: bigint;
}

export interface ReconstructedState {
  splitVersion: number;
  cancelled: boolean;
  participants: Map<string, ReconstructedParticipant>;
}

function asBig(v: unknown, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new LedgerError(`${what} inválido no payload do ledger`);
}

function asString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new LedgerError(`${what} inválido no payload do ledger`);
  return v;
}

export function reconstructFromLedger(entries: readonly LedgerEntry[]): ReconstructedState {
  const state: ReconstructedState = { splitVersion: 0, cancelled: false, participants: new Map() };
  const get = (id: string): ReconstructedParticipant => {
    let p = state.participants.get(id);
    if (!p) {
      p = { dueCents: 0n, paidCents: 0n, selfSettledCents: 0n, refundRecordedCents: 0n };
      state.participants.set(id, p);
    }
    return p;
  };
  for (const e of entries) {
    const pl = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'SPLIT_CONFIRMED':
      case 'SPLIT_COMPLEMENTED': {
        state.splitVersion = Number(asBig(pl.version, 'version'));
        const allocations = pl.allocations;
        if (!Array.isArray(allocations)) throw new LedgerError('allocations ausente');
        for (const p of state.participants.values()) p.dueCents = 0n;
        for (const a of allocations as Record<string, unknown>[]) {
          get(asString(a.participantId, 'participantId')).dueCents = asBig(a.dueCents, 'dueCents');
        }
        break;
      }
      case 'SPLIT_UNLOCKED':
        for (const p of state.participants.values()) {
          p.dueCents = 0n;
          p.selfSettledCents = 0n;
        }
        break;
      case 'ORGANIZER_SHARE_SELF_SETTLED':
        get(asString(pl.participantId, 'participantId')).selfSettledCents = asBig(pl.amountCents, 'amountCents');
        break;
      case 'PAYMENT_CONFIRMED':
        get(asString(pl.participantId, 'participantId')).paidCents += asBig(pl.amountCents, 'amountCents');
        break;
      case 'PAYMENT_REFUNDED':
      case 'PAYMENT_CHARGEDBACK':
        get(asString(pl.participantId, 'participantId')).paidCents -= asBig(pl.amountCents, 'amountCents');
        break;
      case 'REFUND_RECORDED':
        get(asString(pl.participantId, 'participantId')).refundRecordedCents += asBig(pl.amountCents, 'amountCents');
        break;
      case 'BILL_CANCELLED':
        state.cancelled = true;
        break;
      default:
        break;
    }
  }
  return state;
}
