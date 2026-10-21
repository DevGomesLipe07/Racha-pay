// Racha Engine — puro, determinístico, sem I/O e sem IA (Constituição § A IA apoia; 02 § Racha Engine).
//
// 1. Cada item é dividido entre os marcados, pelos pesos; item sem marcados = todos.
// 2. total = subtotal − desconto + serviço + gorjeta.
// 3. serviço = round_half_up(bp × (subtotal − desconto) / 10.000).
// 4. desconto, serviço e gorjeta proporcionais ao consumo (ou ao percentual / valor manual — D7).
// 5. Centavos por maiores restos; empate pela ordem dos participantes.
// 6. O total de cada pessoa é a divisão justa (maiores restos) do total da conta e cada coluna
//    fecha no centavo; um componente individual pode se afastar do proporcional exato, o total nunca.

import { allocateLargestRemainder, lcm, MAX_CENTS, roundHalfUp, sumCents, type Cents } from './money.ts';

export const SPLIT_MODES = ['EQUAL', 'BY_ITEM', 'PERCENT', 'MANUAL'] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];

export const BP_SCALE = 10_000;
const MAX_QUANTITY = 10_000;
const MAX_WEIGHT = 1_000;

export interface SplitParticipant {
  id: string;
}

export interface SplitItemAssignee {
  participantId: string;
  /** Inteiro positivo; padrão 1. */
  weight?: number;
}

export interface SplitItem {
  id: string;
  unitPriceCents: Cents;
  quantity: number;
  assignees: readonly SplitItemAssignee[];
}

export interface SplitInput {
  mode: SplitMode;
  participants: readonly SplitParticipant[];
  items: readonly SplitItem[];
  discountCents: Cents;
  serviceBp: number;
  tipCents: Cents;
  /** PERCENT: pontos-base por participante, soma = 10.000. */
  percentBp?: Readonly<Record<string, number>>;
  /** MANUAL: centavos por participante, soma = total final. */
  manualCents?: Readonly<Record<string, Cents>>;
  /** Limites vindos da Expert Library (o engine não guarda regra parametrizável). */
  limits: { maxServiceBp: number };
}

export interface ParticipantShare {
  participantId: string;
  itemsCents: Cents;
  discountCents: Cents;
  serviceCents: Cents;
  tipCents: Cents;
  totalCents: Cents;
}

export interface SplitResult {
  mode: SplitMode;
  subtotalCents: Cents;
  discountCents: Cents;
  serviceCents: Cents;
  tipCents: Cents;
  totalCents: Cents;
  shares: ParticipantShare[];
}

export class SplitInputError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SplitInputError';
    this.code = code;
    this.details = details;
  }
}

export class SplitInvariantError extends Error {
  constructor(message: string) {
    super(`invariante da divisão violada: ${message}`);
    this.name = 'SplitInvariantError';
  }
}

function assertPositiveInt(value: number, max: number, code: string, what: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new SplitInputError(code, `${what} deve ser inteiro entre 1 e ${max}`, { value });
  }
}

function assertCentsRange(value: Cents, code: string, what: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_CENTS) {
    throw new SplitInputError(code, `${what} fora da faixa`, { value: String(value) });
  }
}

interface Validated {
  participantIndex: Map<string, number>;
  itemAmounts: Cents[];
  subtotal: Cents;
}

function validate(input: SplitInput): Validated {
  if (!SPLIT_MODES.includes(input.mode)) {
    throw new SplitInputError('INVALID_MODE', 'modo de divisão inválido', { mode: input.mode });
  }
  if (input.participants.length === 0) {
    throw new SplitInputError('NO_PARTICIPANTS', 'a divisão exige pelo menos um participante');
  }
  const participantIndex = new Map<string, number>();
  input.participants.forEach((p, i) => {
    if (!p.id) throw new SplitInputError('INVALID_PARTICIPANT', 'participante sem id');
    if (participantIndex.has(p.id)) {
      throw new SplitInputError('DUPLICATE_PARTICIPANT', 'participante repetido', { participantId: p.id });
    }
    participantIndex.set(p.id, i);
  });

  const itemIds = new Set<string>();
  const itemAmounts: Cents[] = [];
  for (const item of input.items) {
    if (!item.id) throw new SplitInputError('INVALID_ITEM', 'item sem id');
    if (itemIds.has(item.id)) throw new SplitInputError('DUPLICATE_ITEM', 'item repetido', { itemId: item.id });
    itemIds.add(item.id);
    assertCentsRange(item.unitPriceCents, 'AMOUNT_OUT_OF_RANGE', 'preço unitário');
    assertPositiveInt(item.quantity, MAX_QUANTITY, 'INVALID_QUANTITY', 'quantidade');
    const seen = new Set<string>();
    for (const a of item.assignees) {
      if (!participantIndex.has(a.participantId)) {
        throw new SplitInputError('UNKNOWN_PARTICIPANT', 'item marcado para participante inexistente', {
          itemId: item.id,
          participantId: a.participantId,
        });
      }
      if (seen.has(a.participantId)) {
        throw new SplitInputError('DUPLICATE_ASSIGNEE', 'participante marcado duas vezes no mesmo item', {
          itemId: item.id,
          participantId: a.participantId,
        });
      }
      seen.add(a.participantId);
      if (a.weight !== undefined) assertPositiveInt(a.weight, MAX_WEIGHT, 'INVALID_WEIGHT', 'peso');
    }
    itemAmounts.push(item.unitPriceCents * BigInt(item.quantity));
  }

  const subtotal = sumCents(itemAmounts);
  if (subtotal > MAX_CENTS) throw new SplitInputError('AMOUNT_OUT_OF_RANGE', 'subtotal acima do teto');
  assertCentsRange(input.discountCents, 'AMOUNT_OUT_OF_RANGE', 'desconto');
  assertCentsRange(input.tipCents, 'AMOUNT_OUT_OF_RANGE', 'gorjeta');
  if (input.discountCents > subtotal) {
    throw new SplitInputError('DISCOUNT_EXCEEDS_SUBTOTAL', 'desconto maior que o subtotal');
  }
  const maxServiceBp = input.limits.maxServiceBp;
  if (!Number.isSafeInteger(maxServiceBp) || maxServiceBp < 0 || maxServiceBp > BP_SCALE) {
    throw new SplitInputError('INVALID_LIMITS', 'limite de serviço inválido');
  }
  if (!Number.isSafeInteger(input.serviceBp) || input.serviceBp < 0 || input.serviceBp > maxServiceBp) {
    throw new SplitInputError('SERVICE_BP_OUT_OF_RANGE', `serviço deve estar entre 0 e ${maxServiceBp} bp`, {
      serviceBp: input.serviceBp,
    });
  }
  return { participantIndex, itemAmounts, subtotal };
}

/** Pesos de consumo exatos (racionais com denominador comum), sem arredondar por item. */
function consumptionWeights(input: SplitInput, v: Validated): bigint[] {
  const n = input.participants.length;
  const perItem = input.items.map((item) => {
    const assignees =
      item.assignees.length > 0
        ? item.assignees.map((a) => ({ index: v.participantIndex.get(a.participantId) as number, w: BigInt(a.weight ?? 1) }))
        : input.participants.map((_, index) => ({ index, w: 1n }));
    const weightSum = assignees.reduce((s, a) => s + a.w, 0n);
    return { assignees, weightSum };
  });
  let denominator = 1n;
  for (const { weightSum } of perItem) denominator = lcm(denominator, weightSum);
  const weights = new Array<bigint>(n).fill(0n);
  perItem.forEach(({ assignees, weightSum }, i) => {
    const amount = v.itemAmounts[i] as bigint;
    const scale = denominator / weightSum;
    for (const a of assignees) weights[a.index] = (weights[a.index] as bigint) + amount * a.w * scale;
  });
  return weights;
}

function modeWeights(input: SplitInput, v: Validated, total: Cents): bigint[] {
  const ids = input.participants.map((p) => p.id);
  switch (input.mode) {
    case 'EQUAL':
      return ids.map(() => 1n);
    case 'BY_ITEM':
      return consumptionWeights(input, v);
    case 'PERCENT': {
      const map = input.percentBp ?? {};
      const extra = Object.keys(map).filter((k) => !v.participantIndex.has(k));
      if (extra.length > 0) throw new SplitInputError('UNKNOWN_PARTICIPANT', 'percentual para participante inexistente', { extra });
      let sum = 0;
      const weights = ids.map((id) => {
        const bp = map[id] ?? 0;
        if (!Number.isSafeInteger(bp) || bp < 0 || bp > BP_SCALE) {
          throw new SplitInputError('PERCENT_INVALID', 'percentual inválido', { participantId: id, bp });
        }
        sum += bp;
        return BigInt(bp);
      });
      if (sum !== BP_SCALE) throw new SplitInputError('PERCENT_SUM_INVALID', 'os percentuais devem somar 100%', { sumBp: sum });
      return weights;
    }
    case 'MANUAL': {
      const map = input.manualCents ?? {};
      const extra = Object.keys(map).filter((k) => !v.participantIndex.has(k));
      if (extra.length > 0) throw new SplitInputError('UNKNOWN_PARTICIPANT', 'valor para participante inexistente', { extra });
      const weights = ids.map((id) => {
        const c = map[id] ?? 0n;
        assertCentsRange(c, 'AMOUNT_OUT_OF_RANGE', 'valor manual');
        return c;
      });
      const sum = sumCents(weights);
      if (sum !== total) {
        throw new SplitInputError('MANUAL_SUM_INVALID', 'os valores manuais devem somar o total da conta', {
          sumCents: String(sum),
          totalCents: String(total),
        });
      }
      return weights;
    }
  }
}

type Column = 'items' | 'discount' | 'service' | 'tip';

interface Grid {
  items: Cents[];
  discount: Cents[];
  service: Cents[];
  tip: Cents[];
}

/** Distância |x·W − X·w| (numerador da distância ao proporcional exato, sobre W). */
function deviation(x: Cents, columnTotal: Cents, w: bigint, weightSum: bigint): bigint {
  const d = x * weightSum - columnTotal * w;
  return d < 0n ? -d : d;
}

/**
 * Aloca as colunas de forma que (a) cada coluna fecha no centavo, (b) o total de cada pessoa é a
 * divisão por maiores restos do total da conta e (c) nenhum componente fica negativo. Começa com
 * maiores restos por coluna e corrige as diferenças movendo 1 centavo por vez, sempre o movimento
 * que menos se afasta do proporcional exato.
 */
function allocateColumns(
  totals: Record<Column, Cents>,
  grandTotal: Cents,
  weights: bigint[],
): { grid: Grid; personTotals: Cents[] } {
  const n = weights.length;
  let w = weights;
  let weightSum = w.reduce((s, x) => s + x, 0n);
  if (weightSum === 0n) {
    // Consumo zero (itens de valor 0): o restante (gorjeta) se divide igualmente.
    w = weights.map(() => 1n);
    weightSum = BigInt(n);
  }
  const grid: Grid = {
    items: allocateLargestRemainder(totals.items, w),
    discount: allocateLargestRemainder(totals.discount, w),
    service: allocateLargestRemainder(totals.service, w),
    tip: allocateLargestRemainder(totals.tip, w),
  };
  const personTotals = allocateLargestRemainder(grandTotal, w);
  const rowSum = (i: number): Cents =>
    (grid.items[i] as bigint) - (grid.discount[i] as bigint) + (grid.service[i] as bigint) + (grid.tip[i] as bigint);
  const delta = personTotals.map((t, i) => t - rowSum(i));

  const at = (c: Column, i: number): bigint => grid[c][i] as bigint;
  const set = (c: Column, i: number, value: bigint): void => {
    grid[c][i] = value;
  };

  // Movimento que soma 1 centavo a `up` e tira 1 de `down`.
  const moves: { column: Column; priority: number; upChange: bigint }[] = [
    { column: 'service', priority: 0, upChange: 1n },
    { column: 'tip', priority: 1, upChange: 1n },
    { column: 'discount', priority: 2, upChange: -1n },
    { column: 'items', priority: 3, upChange: 1n },
  ];

  let guard = 0;
  for (;;) {
    const up = delta.findIndex((d) => d > 0n);
    if (up === -1) break;
    if (++guard > 100_000) throw new SplitInvariantError('correção de colunas não convergiu');
    let best: { column: Column; upChange: bigint; down: number; cost: bigint; priority: number } | undefined;
    for (let down = 0; down < n; down++) {
      if ((delta[down] as bigint) >= 0n) continue;
      for (const m of moves) {
        const newUp = at(m.column, up) + m.upChange;
        const newDown = at(m.column, down) - m.upChange;
        if (newUp < 0n || newDown < 0n) continue;
        const cost = [
          deviation(newUp, totals[m.column], w[up] as bigint, weightSum),
          deviation(newDown, totals[m.column], w[down] as bigint, weightSum),
        ].reduce((a, b) => (a > b ? a : b));
        // Itens só como último recurso: penalidade grande.
        const effective = m.column === 'items' ? cost + weightSum * 4n : cost;
        if (
          !best ||
          effective < best.cost ||
          (effective === best.cost && (m.priority < best.priority || (m.priority === best.priority && down < best.down)))
        ) {
          best = { column: m.column, upChange: m.upChange, down, cost: effective, priority: m.priority };
        }
      }
    }
    if (!best) throw new SplitInvariantError('nenhum movimento de centavo possível');
    set(best.column, up, at(best.column, up) + best.upChange);
    set(best.column, best.down, at(best.column, best.down) - best.upChange);
    delta[up] = (delta[up] as bigint) - 1n;
    delta[best.down] = (delta[best.down] as bigint) + 1n;
  }
  return { grid, personTotals };
}

export function computeSplit(input: SplitInput): SplitResult {
  const v = validate(input);
  const subtotal = v.subtotal;
  const discount = input.discountCents;
  const service = roundHalfUp(BigInt(input.serviceBp) * (subtotal - discount), BigInt(BP_SCALE));
  const tip = input.tipCents;
  const total = subtotal - discount + service + tip;
  if (total > MAX_CENTS) throw new SplitInputError('AMOUNT_OUT_OF_RANGE', 'total acima do teto');

  const weights = modeWeights(input, v, total);
  const { grid, personTotals } = allocateColumns(
    { items: subtotal, discount, service, tip },
    total,
    weights,
  );

  const result: SplitResult = {
    mode: input.mode,
    subtotalCents: subtotal,
    discountCents: discount,
    serviceCents: service,
    tipCents: tip,
    totalCents: total,
    shares: input.participants.map((p, i) => ({
      participantId: p.id,
      itemsCents: grid.items[i] as bigint,
      discountCents: grid.discount[i] as bigint,
      serviceCents: grid.service[i] as bigint,
      tipCents: grid.tip[i] as bigint,
      totalCents: personTotals[i] as bigint,
    })),
  };
  assertSplitInvariants(result);
  return result;
}

/** Verificação independente; chamada antes de qualquer persistência. */
export function assertSplitInvariants(r: SplitResult): void {
  if (r.totalCents !== r.subtotalCents - r.discountCents + r.serviceCents + r.tipCents) {
    throw new SplitInvariantError('total ≠ subtotal − desconto + serviço + gorjeta');
  }
  const col = (pick: (s: ParticipantShare) => Cents) => sumCents(r.shares.map(pick));
  if (col((s) => s.itemsCents) !== r.subtotalCents) throw new SplitInvariantError('coluna de itens não fecha');
  if (col((s) => s.discountCents) !== r.discountCents) throw new SplitInvariantError('coluna de desconto não fecha');
  if (col((s) => s.serviceCents) !== r.serviceCents) throw new SplitInvariantError('coluna de serviço não fecha');
  if (col((s) => s.tipCents) !== r.tipCents) throw new SplitInvariantError('coluna de gorjeta não fecha');
  if (col((s) => s.totalCents) !== r.totalCents) throw new SplitInvariantError('soma das partes ≠ total');
  for (const s of r.shares) {
    if (s.itemsCents < 0n || s.discountCents < 0n || s.serviceCents < 0n || s.tipCents < 0n || s.totalCents < 0n) {
      throw new SplitInvariantError(`componente negativo para ${s.participantId}`);
    }
    if (s.totalCents !== s.itemsCents - s.discountCents + s.serviceCents + s.tipCents) {
      throw new SplitInvariantError(`linha de ${s.participantId} não fecha`);
    }
  }
}
