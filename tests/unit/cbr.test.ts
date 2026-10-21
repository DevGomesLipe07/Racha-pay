import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jaccard } from '../../src/modules/cbr/service.ts';
import { isCriticalKey, schemaFor } from '../../src/modules/expert/library.ts';

test('Jaccard: |A ∩ B| / |A ∪ B|', () => {
  assert.equal(jaccard(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  assert.equal(jaccard(['a'], ['b']), 0);
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(['a', 'a', 'b'], ['a', 'b']), 1, 'repetição não conta');
});

test('Expert Library: chaves de dinheiro e playbooks do CBR são críticas; chave sem schema é recusada', () => {
  for (const k of ['SERVICE_CHARGE.DEFAULT', 'PAYMENT.EXPIRY', 'CBR_PLAYBOOK.OVERPAYMENT']) assert.equal(isCriticalKey(k), true, k);
  for (const k of ['IDEMPOTENCY.TTL', 'WEBHOOK.RETRY', 'RATE_LIMIT.ANON_BILL_CREATE']) assert.equal(isCriticalKey(k), false, k);
  assert.ok(schemaFor('CBR_PLAYBOOK.CHARGEBACK'));
  assert.equal(schemaFor('QUALQUER.COISA'), undefined);
  assert.equal(schemaFor('TIP.ALLOCATION')?.safeParse({ method: 'EQUAL' }).success, false, 'método sem suporte no engine não passa');
});
