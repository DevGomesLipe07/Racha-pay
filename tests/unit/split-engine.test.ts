import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSplitInvariants,
  computeSplit,
  SplitInputError,
  type SplitInput,
  type SplitItem,
  type SplitMode,
} from '../../src/modules/split/engine.ts';
import { allocateLargestRemainder } from '../../src/modules/split/money.ts';

const limits = { maxServiceBp: 3000 };
const people = (...ids: string[]) => ids.map((id) => ({ id }));
const item = (id: string, cents: number, assignees: string[] = [], quantity = 1): SplitItem => ({
  id,
  unitPriceCents: BigInt(cents),
  quantity,
  assignees: assignees.map((participantId) => ({ participantId })),
});
const base = (over: Partial<SplitInput>): SplitInput => ({
  mode: 'EQUAL',
  participants: people('a', 'b', 'c'),
  items: [],
  discountCents: 0n,
  serviceBp: 0,
  tipCents: 0n,
  limits,
  ...over,
});
const totals = (r: ReturnType<typeof computeSplit>) => r.shares.map((s) => s.totalCents);

test('igual: R$ 100,00 / 3', () => {
  const r = computeSplit(base({ items: [item('x', 10000)] }));
  assert.deepEqual(totals(r), [3334n, 3333n, 3333n]);
  assert.equal(r.totalCents, 10000n);
});

test('igual: R$ 10,01 / 3', () => {
  const r = computeSplit(base({ items: [item('x', 1001)] }));
  assert.deepEqual(totals(r), [334n, 334n, 333n]);
});

test('igual: vários itens não acumulam centavo no primeiro participante', () => {
  // 3 itens de R$ 10,00 → R$ 30,00 / 3 = 10,00 cada (arredondar por item daria 10,02 / 9,99 / 9,99)
  const r = computeSplit(base({ items: [item('x', 1000), item('y', 1000), item('z', 1000)] }));
  assert.deepEqual(totals(r), [1000n, 1000n, 1000n]);
});

test('por item: item compartilhado por 7', () => {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  const r = computeSplit(base({ mode: 'BY_ITEM', participants: people(...ids), items: [item('pizza', 10000, ids)] }));
  assert.deepEqual(totals(r), [1429n, 1429n, 1429n, 1429n, 1428n, 1428n, 1428n]);
});

test('por item: cada um paga o que consumiu; item sem marcação é de todos', () => {
  const r = computeSplit(
    base({
      mode: 'BY_ITEM',
      items: [item('picanha', 9000, ['a']), item('salada', 3000, ['b']), item('agua', 900)],
    }),
  );
  assert.deepEqual(totals(r), [9300n, 3300n, 300n]);
});

test('por item: pesos (a come o dobro)', () => {
  const r = computeSplit(
    base({
      mode: 'BY_ITEM',
      participants: people('a', 'b'),
      items: [{ id: 'x', unitPriceCents: 900n, quantity: 1, assignees: [{ participantId: 'a', weight: 2 }, { participantId: 'b' }] }],
    }),
  );
  assert.deepEqual(totals(r), [600n, 300n]);
});

test('serviço 10% sobre a base após desconto, meio-para-cima', () => {
  const r = computeSplit(base({ items: [item('x', 10005)], discountCents: 0n, serviceBp: 1000 }));
  assert.equal(r.serviceCents, 1001n); // 1000,5 → 1001
  const d = computeSplit(base({ items: [item('x', 10000)], discountCents: 2000n, serviceBp: 1000 }));
  assert.equal(d.serviceCents, 800n);
  assert.equal(d.totalCents, 8800n);
});

test('desconto e gorjeta proporcionais ao consumo', () => {
  const r = computeSplit(
    base({
      mode: 'BY_ITEM',
      participants: people('a', 'b'),
      items: [item('x', 7500, ['a']), item('y', 2500, ['b'])],
      discountCents: 1000n,
      tipCents: 400n,
    }),
  );
  const [a, b] = r.shares;
  assert.equal(a?.discountCents, 750n);
  assert.equal(b?.discountCents, 250n);
  assert.equal(a?.tipCents, 300n);
  assert.equal(b?.tipCents, 100n);
  assert.equal(r.totalCents, 9400n);
});

test('percentual: divide o total final por pontos-base', () => {
  const r = computeSplit(
    base({
      mode: 'PERCENT',
      items: [item('x', 10000)],
      serviceBp: 1000,
      percentBp: { a: 5000, b: 3000, c: 2000 },
    }),
  );
  assert.deepEqual(totals(r), [5500n, 3300n, 2200n]);
});

test('percentual: recusa soma diferente de 100%', () => {
  assert.throws(
    () => computeSplit(base({ mode: 'PERCENT', items: [item('x', 100)], percentBp: { a: 5000, b: 4000 } })),
    (e: unknown) => e instanceof SplitInputError && e.code === 'PERCENT_SUM_INVALID',
  );
});

test('manual: valores exatos e soma = total final', () => {
  const r = computeSplit(
    base({
      mode: 'MANUAL',
      items: [item('x', 10000)],
      serviceBp: 1000,
      manualCents: { a: 5000n, b: 3000n, c: 3000n },
    }),
  );
  assert.deepEqual(totals(r), [5000n, 3000n, 3000n]);
  assert.throws(
    () => computeSplit(base({ mode: 'MANUAL', items: [item('x', 10000)], manualCents: { a: 1n } })),
    (e: unknown) => e instanceof SplitInputError && e.code === 'MANUAL_SUM_INVALID',
  );
});

test('validações de entrada', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof SplitInputError ? e.code : 'OTHER';
    }
    return 'NONE';
  };
  assert.equal(code(() => computeSplit(base({ participants: [] }))), 'NO_PARTICIPANTS');
  assert.equal(code(() => computeSplit(base({ participants: people('a', 'a') }))), 'DUPLICATE_PARTICIPANT');
  assert.equal(code(() => computeSplit(base({ items: [item('x', 100, ['z'])] }))), 'UNKNOWN_PARTICIPANT');
  assert.equal(code(() => computeSplit(base({ items: [item('x', 100)], discountCents: 101n }))), 'DISCOUNT_EXCEEDS_SUBTOTAL');
  assert.equal(code(() => computeSplit(base({ items: [item('x', 100)], serviceBp: 3001 }))), 'SERVICE_BP_OUT_OF_RANGE');
  assert.equal(code(() => computeSplit(base({ items: [item('x', 100, [], 0)] }))), 'INVALID_QUANTITY');
  assert.equal(code(() => computeSplit(base({ items: [item('x', 100), item('x', 1)] }))), 'DUPLICATE_ITEM');
});

test('conta só com gorjeta (itens de valor zero) divide igualmente', () => {
  const r = computeSplit(base({ mode: 'BY_ITEM', items: [item('x', 0, ['a'])], tipCents: 300n }));
  assert.deepEqual(totals(r), [100n, 100n, 100n]);
});

test('determinismo: mesma entrada, mesma saída', () => {
  const input = base({
    mode: 'BY_ITEM',
    items: [item('x', 3333, ['a', 'b']), item('y', 7777, ['b', 'c']), item('z', 101)],
    discountCents: 77n,
    serviceBp: 1300,
    tipCents: 999n,
  });
  assert.deepEqual(computeSplit(input), computeSplit(input));
});

// ---------------------------------------------------------------------------
// Propriedade: 3.500 cenários aleatórios (PRNG com semente fixa → reprodutível).

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('propriedade: 3.500 cenários — colunas fecham, total por pessoa é o justo, nada negativo', (t) => {
  const rand = prng(20261021);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const modes: SplitMode[] = ['EQUAL', 'BY_ITEM', 'PERCENT', 'MANUAL'];
  let maxDeviationCents = 0;

  for (let scenario = 0; scenario < 3500; scenario++) {
    const n = int(1, 12);
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const items: SplitItem[] = Array.from({ length: int(0, 15) }, (_, i) => ({
      id: `i${i}`,
      unitPriceCents: BigInt(rand() < 0.05 ? 0 : int(1, 50000)),
      quantity: int(1, 4),
      assignees: ids
        .filter(() => rand() < 0.4)
        .map((participantId) => ({ participantId, weight: rand() < 0.2 ? int(2, 5) : 1 })),
    }));
    const subtotal = items.reduce((s, it) => s + it.unitPriceCents * BigInt(it.quantity), 0n);
    const discount = subtotal > 0n && rand() < 0.4 ? BigInt(int(0, Number(subtotal))) : 0n;
    const mode = modes[int(0, 3)] as SplitMode;
    const input: SplitInput = {
      mode,
      participants: ids.map((id) => ({ id })),
      items,
      discountCents: discount,
      serviceBp: rand() < 0.5 ? 0 : int(0, 3000),
      tipCents: rand() < 0.4 ? BigInt(int(0, 20000)) : 0n,
      limits,
    };
    if (mode === 'PERCENT') {
      const raw = allocateLargestRemainder(10000n, ids.map(() => BigInt(int(0, 10))).map((w, i, arr) => (arr.every((x) => x === 0n) && i === 0 ? 1n : w)));
      input.percentBp = Object.fromEntries(ids.map((id, i) => [id, Number(raw[i])]));
    }
    if (mode === 'MANUAL') {
      const preview = computeSplit({ ...input, mode: 'EQUAL' });
      const raw = allocateLargestRemainder(preview.totalCents, ids.map(() => BigInt(int(1, 10))));
      input.manualCents = Object.fromEntries(ids.map((id, i) => [id, raw[i] as bigint]));
    }

    const r = computeSplit(input);
    assertSplitInvariants(r);
    assert.deepEqual(computeSplit(input), r, `determinismo #${scenario}`);
    assert.ok(r.shares.every((s) => s.totalCents >= 0n));

    // Total de cada pessoa = maiores restos do total da conta pelos pesos do modo.
    if (mode === 'EQUAL') {
      assert.deepEqual(totals(r), allocateLargestRemainder(r.totalCents, ids.map(() => 1n)), `#${scenario}`);
    }
    if (mode === 'MANUAL') {
      assert.deepEqual(totals(r), ids.map((id) => input.manualCents?.[id]), `#${scenario}`);
    }

    // Afastamento de cada componente em relação ao proporcional exato pelos pesos do modo.
    const weights: number[] = ids.map((id) => {
      if (mode === 'EQUAL') return 1;
      if (mode === 'PERCENT') return input.percentBp?.[id] ?? 0;
      if (mode === 'MANUAL') return Number(input.manualCents?.[id] ?? 0n);
      return items.reduce((s, it) => {
        const marked = it.assignees.length > 0 ? it.assignees : ids.map((participantId) => ({ participantId, weight: 1 }));
        const wsum = marked.reduce((a, m) => a + (m.weight ?? 1), 0);
        const mine = marked.find((m) => m.participantId === id);
        return s + (mine ? (Number(it.unitPriceCents) * it.quantity * (mine.weight ?? 1)) / wsum : 0);
      }, 0);
    });
    const wsum = weights.reduce((a, b) => a + b, 0);
    if (wsum > 0) {
      for (const [column, colTotal] of [
        ['itemsCents', r.subtotalCents],
        ['serviceCents', r.serviceCents],
        ['tipCents', r.tipCents],
        ['discountCents', r.discountCents],
      ] as const) {
        r.shares.forEach((s, i) => {
          const exact = (Number(colTotal) * (weights[i] as number)) / wsum;
          maxDeviationCents = Math.max(maxDeviationCents, Math.abs(Number(s[column]) - exact));
        });
      }
    }
  }
  // 02 § Racha Engine (6): um componente individual pode se afastar do proporcional exato; o total nunca.
  t.diagnostic(`afastamento máximo de componente: ${maxDeviationCents.toFixed(4)} centavo`);
  assert.ok(maxDeviationCents < 2, `afastamento máximo de componente: ${maxDeviationCents}`);
});
