import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chainNext,
  GENESIS_HASH,
  LedgerError,
  reconstructFromLedger,
  verifyChain,
  type LedgerEntry,
  type LedgerEntryDraft,
} from '../../src/modules/ledger/chain.ts';

const actor = { type: 'HUMAN' as const, id: 'org' };
const draft = (type: LedgerEntryDraft['type'], payload: LedgerEntryDraft['payload'], i = 0): LedgerEntryDraft => ({
  billId: 'bill-1',
  type,
  payload,
  actor,
  correlationId: `corr-${i}`,
  occurredAt: new Date(Date.UTC(2026, 9, 21, 12, 0, i)).toISOString(),
});

function build(drafts: LedgerEntryDraft[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const d of drafts) out.push(chainNext(out.at(-1), d));
  return out;
}

const flow = () =>
  build([
    draft('BILL_CREATED', { kind: 'RESTAURANT' }, 0),
    draft('SPLIT_CONFIRMED', { version: 1, allocations: [{ participantId: 'a', dueCents: 6000n }, { participantId: 'b', dueCents: 4000n }] }, 1),
    draft('ORGANIZER_SHARE_SELF_SETTLED', { participantId: 'a', amountCents: 6000n }, 2),
    draft('PAYMENT_CONFIRMED', { paymentId: 'p1', participantId: 'b', amountCents: 4500n }, 3),
    draft('REFUND_RECORDED', { participantId: 'b', amountCents: 500n }, 4),
  ]);

test('cadeia: gênese, sequência e encadeamento', () => {
  const entries = flow();
  assert.equal(entries[0]?.seq, 1);
  assert.equal(entries[0]?.prevHash, GENESIS_HASH);
  assert.equal(entries[1]?.prevHash, entries[0]?.entryHash);
  assert.match(entries[4]?.entryHash ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(verifyChain(entries), { valid: true, entries: 5 });
});

test('cadeia: hash determinístico (bigint e number iguais)', () => {
  const a = chainNext(undefined, draft('PAYMENT_CONFIRMED', { participantId: 'b', amountCents: 4500n }));
  const b = chainNext(undefined, draft('PAYMENT_CONFIRMED', { participantId: 'b', amountCents: 4500 }));
  assert.equal(a.entryHash, b.entryHash);
});

test('adulteração: valor alterado é detectado', () => {
  const entries = flow();
  const tampered = entries.map((e) => ({ ...e }));
  (tampered[3] as LedgerEntry).payload = { paymentId: 'p1', participantId: 'b', amountCents: 1n };
  const v = verifyChain(tampered);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 4);
});

test('adulteração: entrada removida ou reordenada é detectada', () => {
  const entries = flow();
  assert.equal(verifyChain([...entries.slice(0, 2), ...entries.slice(3)]).valid, false);
  assert.equal(verifyChain([entries[1] as LedgerEntry, entries[0] as LedgerEntry]).valid, false);
});

test('adulteração: recalcular só o hash adulterado quebra o elo seguinte', () => {
  const entries = flow();
  const t = entries.map((e) => ({ ...e }));
  const forged = chainNext(t[1], { ...(t[2] as LedgerEntry), payload: { participantId: 'a', amountCents: 1n } });
  t[2] = forged;
  const v = verifyChain(t);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 4);
});

test('reconstrução: devido e pago saem só do ledger', () => {
  const state = reconstructFromLedger(flow());
  assert.equal(state.splitVersion, 1);
  assert.deepEqual(state.participants.get('a'), { dueCents: 6000n, paidCents: 0n, selfSettledCents: 6000n, refundRecordedCents: 0n });
  assert.deepEqual(state.participants.get('b'), { dueCents: 4000n, paidCents: 4500n, selfSettledCents: 0n, refundRecordedCents: 500n });
});

test('reconstrução: complemento substitui o devido; estorno e chargeback reduzem o pago', () => {
  const entries = build([
    draft('SPLIT_CONFIRMED', { version: 1, allocations: [{ participantId: 'b', dueCents: 1000n }] }, 0),
    draft('PAYMENT_CONFIRMED', { paymentId: 'p1', participantId: 'b', amountCents: 1000n }, 1),
    draft('SPLIT_COMPLEMENTED', { version: 2, allocations: [{ participantId: 'b', dueCents: 1500n }] }, 2),
    draft('PAYMENT_REFUNDED', { paymentId: 'p1', participantId: 'b', amountCents: 200n }, 3),
    draft('PAYMENT_CHARGEDBACK', { paymentId: 'p1', participantId: 'b', amountCents: 100n }, 4),
    draft('BILL_CANCELLED', {}, 5),
  ]);
  const s = reconstructFromLedger(entries);
  assert.equal(s.splitVersion, 2);
  assert.equal(s.participants.get('b')?.dueCents, 1500n);
  assert.equal(s.participants.get('b')?.paidCents, 700n);
  assert.equal(s.cancelled, true);
});

test('cadeia recusa tipo de evento fora da lista D13', () => {
  assert.throws(() => chainNext(undefined, { ...draft('BILL_CREATED', {}), type: 'MAGIC' as never }), LedgerError);
});
