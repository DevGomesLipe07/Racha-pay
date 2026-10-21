import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceiptText } from '../../src/modules/ai/receipt-parser.ts';
import { explainReconciliation, SKILLS } from '../../src/modules/ai/skills.ts';
import { reconcile } from '../../src/modules/reconciliation/reconcile.ts';
import { saoPauloMonth } from '../../src/modules/analytics/metrics.ts';

test('cupom em texto: formatos comuns, sem "x" sobrando na descrição, totais ignorados', () => {
  const s = parseReceiptText(
    [
      'RESTAURANTE BOM GOSTO LTDA',
      'CNPJ 12.345.678/0001-90',
      'PICANHA NA CHAPA        89,90',
      '2 x CERVEJA 600ML       24,00',
      'REFRI LATA 3 UN 6,00 18,00',
      '1x Sobremesa 15,50',
      'SUBTOTAL               147,40',
      'TAXA SERVICO 10%        14,74',
      'TOTAL                  147,40',
      'PIX                    162,14',
    ].join('\n'),
  );
  assert.deepEqual(
    s.items.map((i) => [i.description, i.quantity, i.unitPriceCents]),
    [
      ['PICANHA NA CHAPA', 1, 8990],
      ['CERVEJA 600ML', 2, 1200],
      ['REFRI LATA', 3, 600],
      ['Sobremesa', 1, 1550],
    ],
  );
  assert.equal(s.printedTotalCents, 14740);
  assert.deepEqual(s.warnings, []);
  assert.equal(s.requiresConfirmation, true);
  assert.equal(s.source, 'TEXT_PARSER');
});

test('cupom em texto: milhar, total que não fecha e linha que não divide viram aviso (não inventa centavo)', () => {
  const s = parseReceiptText(['VINHO RESERVA 1.250,00', '3 x PAO 10,00', 'TOTAL 1.000,00'].join('\n'));
  assert.deepEqual(s.items[0], { description: 'VINHO RESERVA', quantity: 1, unitPriceCents: 125000, lineTotalCents: 125000 });
  assert.deepEqual([s.items[1]?.quantity, s.items[1]?.unitPriceCents], [1, 1000]);
  assert.equal(s.warnings.length, 2);
});

test('explicação da conciliação é determinística e cita o excedente sem cobrir outra parte', () => {
  const r = reconcile({
    totalCents: 10000n,
    allocations: [
      { participantId: 'a', dueCents: 5000n, selfSettledCents: 5000n, refundRecordedCents: 0n },
      { participantId: 'b', dueCents: 5000n, selfSettledCents: 0n, refundRecordedCents: 0n },
    ],
    payments: [{ id: 'p', participantId: 'b', method: 'MANUAL', amountCents: 5000n, status: 'CONFIRMED', refundedCents: 0n, chargedbackCents: 0n, deferred: [] }],
  });
  const lines = explainReconciliation('SETTLED', r, new Map([['a', 'Ana'], ['b', 'Bruno']]));
  assert.match(lines[0] as string, /Racha quitado/);
  assert.match(lines[1] as string, /Total da conta: R\$ 100,00/);
  assert.ok(lines.some((l) => /Ana organizou/.test(l)));
  assert.ok(lines.some((l) => /Bruno pagou R\$ 50,00 de R\$ 50,00/.test(l)));
  assert.deepEqual(explainReconciliation('SETTLED', r, new Map()), explainReconciliation('SETTLED', r, new Map()));
});

test('skills: manifesto declara que nada é gravado e quando há IA', () => {
  assert.ok(SKILLS.every((s) => s.writes === 'nothing'));
  assert.equal(SKILLS.find((s) => s.name === 'ReceiptUnderstandingSkill')?.requiresConfirmation, true);
  assert.equal(SKILLS.find((s) => s.name === 'ReconciliationExplanationSkill')?.usesAI, 'never');
});

test('mês das métricas no fuso de São Paulo', () => {
  assert.equal(saoPauloMonth(new Date('2026-11-01T02:30:00Z')), '2026-10', '23h30 de 31/10 em SP ainda é outubro');
  assert.equal(saoPauloMonth(new Date('2026-11-01T03:30:00Z')), '2026-11');
});
