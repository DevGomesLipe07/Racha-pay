// Dinheiro sempre em centavos inteiros (BigInt). Nunca float (Constituição § Dinheiro, D14).

export type Cents = bigint;

/** Teto aceito na fronteira da API: R$ 1 bilhão (abaixo de 2^53, D14). */
export const MAX_CENTS: Cents = 100_000_000_000n;

export class MoneyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}

/** Converte um inteiro JSON (centavos) em Cents, validando faixa e tipo. */
export function centsFromJson(value: unknown, field = 'amount'): Cents {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError('AMOUNT_NOT_INTEGER', `${field} deve ser um inteiro em centavos`);
  }
  const cents = BigInt(value);
  if (cents < 0n || cents > MAX_CENTS) {
    throw new MoneyError('AMOUNT_OUT_OF_RANGE', `${field} fora da faixa 0..${MAX_CENTS}`);
  }
  return cents;
}

/** Converte Cents para inteiro JSON. Só é chamado com valores já validados (≤ MAX_CENTS). */
export function centsToJson(cents: Cents): number {
  if (cents > MAX_CENTS || cents < -MAX_CENTS) {
    throw new MoneyError('AMOUNT_OUT_OF_RANGE', 'valor fora da faixa representável');
  }
  return Number(cents);
}

/** Arredondamento meio-para-cima de numerator/denominator (ambos ≥ 0, denominator > 0). */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) {
    throw new MoneyError('INVALID_ROUNDING', 'roundHalfUp exige numerador ≥ 0 e denominador > 0');
  }
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * Maiores restos (método de Hamilton): divide `total` proporcionalmente a `weights`.
 * Soma do resultado = total, sempre. Empate de resto decidido pela posição (menor índice primeiro).
 * Peso zero nunca recebe centavo.
 */
export function allocateLargestRemainder(total: Cents, weights: readonly bigint[]): Cents[] {
  if (total < 0n) throw new MoneyError('NEGATIVE_TOTAL', 'total a alocar não pode ser negativo');
  if (weights.length === 0) throw new MoneyError('NO_WEIGHTS', 'nenhum peso para alocar');
  let weightSum = 0n;
  for (const w of weights) {
    if (w < 0n) throw new MoneyError('NEGATIVE_WEIGHT', 'peso negativo');
    weightSum += w;
  }
  if (weightSum === 0n) {
    if (total === 0n) return weights.map(() => 0n);
    throw new MoneyError('ZERO_WEIGHT_TOTAL', 'soma dos pesos é zero');
  }

  const shares: Cents[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;
  weights.forEach((w, index) => {
    const product = total * w;
    const share = product / weightSum;
    shares.push(share);
    allocated += share;
    remainders.push({ index, remainder: product % weightSum });
  });

  let leftover = total - allocated;
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    shares[index] = (shares[index] as bigint) + 1n;
    leftover -= 1n;
  }
  return shares;
}

export function sumCents(values: readonly Cents[]): Cents {
  let s = 0n;
  for (const v of values) s += v;
  return s;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcd(a, b)) * b;
}
