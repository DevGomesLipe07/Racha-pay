import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateLargestRemainder,
  centsFromJson,
  centsToJson,
  MAX_CENTS,
  MoneyError,
  roundHalfUp,
} from '../../src/modules/split/money.ts';

test('maiores restos: R$ 100,00 / 3 = 33,34 + 33,33 + 33,33', () => {
  assert.deepEqual(allocateLargestRemainder(10000n, [1n, 1n, 1n]), [3334n, 3333n, 3333n]);
});

test('maiores restos: R$ 10,01 / 3 = 3,34 + 3,34 + 3,33', () => {
  assert.deepEqual(allocateLargestRemainder(1001n, [1n, 1n, 1n]), [334n, 334n, 333n]);
});

test('maiores restos: empate decidido pela posição', () => {
  assert.deepEqual(allocateLargestRemainder(1n, [1n, 1n]), [1n, 0n]);
  assert.deepEqual(allocateLargestRemainder(2n, [1n, 1n, 1n]), [1n, 1n, 0n]);
});

test('maiores restos: maior resto vence antes da posição', () => {
  // 10 por pesos 1:2 → 3,333 e 6,666 → 3 + 7
  assert.deepEqual(allocateLargestRemainder(10n, [1n, 2n]), [3n, 7n]);
});

test('maiores restos: peso zero nunca recebe centavo', () => {
  assert.deepEqual(allocateLargestRemainder(5n, [0n, 1n, 1n]), [0n, 3n, 2n]);
});

test('maiores restos: soma sempre igual ao total', () => {
  for (let total = 0n; total < 200n; total++) {
    const weights = [3n, 7n, 11n, 0n, 1n];
    const shares = allocateLargestRemainder(total, weights);
    assert.equal(
      shares.reduce((a, b) => a + b, 0n),
      total,
    );
  }
});

test('maiores restos: recusa total negativo, peso negativo e pesos zerados', () => {
  assert.throws(() => allocateLargestRemainder(-1n, [1n]), MoneyError);
  assert.throws(() => allocateLargestRemainder(1n, [-1n, 2n]), MoneyError);
  assert.throws(() => allocateLargestRemainder(1n, [0n, 0n]), MoneyError);
  assert.deepEqual(allocateLargestRemainder(0n, [0n, 0n]), [0n, 0n]);
});

test('meio-para-cima', () => {
  assert.equal(roundHalfUp(5n, 10n), 1n);
  assert.equal(roundHalfUp(4n, 10n), 0n);
  assert.equal(roundHalfUp(15n, 10n), 2n);
  assert.equal(roundHalfUp(0n, 7n), 0n);
});

test('fronteira JSON: só inteiros na faixa 0..R$ 1 bilhão', () => {
  assert.equal(centsFromJson(8990), 8990n);
  assert.equal(centsFromJson(0), 0n);
  assert.equal(centsFromJson(Number(MAX_CENTS)), MAX_CENTS);
  for (const bad of [1.5, -1, Number(MAX_CENTS) + 1, '100', null, Number.NaN]) {
    assert.throws(() => centsFromJson(bad), MoneyError, String(bad));
  }
  assert.equal(centsToJson(123n), 123);
});
