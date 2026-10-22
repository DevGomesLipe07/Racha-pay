// Contrato que TODO PaymentProvider precisa cumprir (prompt mestre § N, P1: "provider fixtures, contract
// tests"). Um PSP novo (ex.: Asaas) entra com o próprio adapter + fixtures e roda esta mesma bateria:
//   describePaymentProviderContract('asaas', () => ({ provider, fixtures }))
// As fixtures sabem montar um webhook como aquele PSP mandaria (cada PSP autentica de um jeito).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebhookVerificationError, type PaymentProvider } from '../../src/modules/payments/providers.ts';
import { PAYMENT_EVENT_KINDS, type PaymentEventKind } from '../../src/modules/payments/state-machine.ts';

export interface WebhookFixture {
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
}

export interface ProviderFixtures {
  /** Webhook autêntico, emitido "agora". */
  valid(event: { eventId: string; reference: string; kind: PaymentEventKind; amountCents?: number }, at: Date): WebhookFixture;
  /** Mesmo webhook com a autenticação removida. */
  unsigned(event: { eventId: string; reference: string; kind: PaymentEventKind }, at: Date): WebhookFixture;
  /** Uma referência que o provedor devolveria numa cobrança real (formato). */
  referencePattern: RegExp;
  /** Janela anti-replay do provedor, em segundos (null se o PSP não usa timestamp). */
  replayWindowSeconds: number | null;
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof WebhookVerificationError, `esperava WebhookVerificationError, veio ${(e as Error).name}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`esperava erro ${code}`);
}

export function describePaymentProviderContract(name: string, make: () => { provider: PaymentProvider; fixtures: ProviderFixtures }) {
  const now = new Date('2026-10-22T12:00:00.000Z');

  test(`[${name}] createPayment: referência no formato do provedor, única por cobrança`, async () => {
    const { provider, fixtures } = make();
    const a = await provider.createPayment({ paymentId: crypto.randomUUID(), amountCents: 1234n });
    const b = await provider.createPayment({ paymentId: crypto.randomUUID(), amountCents: 1234n });
    assert.match(a.reference, fixtures.referencePattern);
    assert.notEqual(a.reference, b.reference);
  });

  test(`[${name}] verifyWebhook: evento autêntico normalizado para o vocabulário do RachaPay`, async () => {
    const { provider, fixtures } = make();
    const { reference } = await provider.createPayment({ paymentId: crypto.randomUUID(), amountCents: 5000n });
    for (const kind of ['CONFIRMED', 'FAILED', 'REFUNDED', 'CHARGEDBACK'] as const) {
      const f = fixtures.valid({ eventId: `evt-${kind}`, reference, kind, ...(kind === 'REFUNDED' ? { amountCents: 1500 } : {}) }, now);
      const ev = provider.verifyWebhook(f.rawBody, f.headers, now);
      assert.equal(ev.reference, reference);
      assert.equal(ev.eventId, `evt-${kind}`);
      assert.ok((PAYMENT_EVENT_KINDS as readonly string[]).includes(ev.kind));
      assert.equal(ev.kind, kind);
      if (kind === 'REFUNDED') assert.equal(ev.amountCents, 1500n, 'valor sempre em centavos BigInt');
    }
  });

  test(`[${name}] verifyWebhook: sem autenticação ou com corpo adulterado é recusado`, () => {
    const { provider, fixtures } = make();
    const ok = fixtures.valid({ eventId: 'evt-1', reference: 'ref', kind: 'CONFIRMED' }, now);
    const unsigned = fixtures.unsigned({ eventId: 'evt-1', reference: 'ref', kind: 'CONFIRMED' }, now);
    expectCode(() => provider.verifyWebhook(unsigned.rawBody, unsigned.headers, now), 'SIGNATURE_MISSING');
    const tampered = Buffer.from(ok.rawBody.toString().replace('CONFIRMED', 'REFUNDED'));
    expectCode(() => provider.verifyWebhook(tampered, ok.headers, now), 'SIGNATURE_INVALID');
  });

  test(`[${name}] verifyWebhook: replay fora da janela é recusado`, (t) => {
    const { provider, fixtures } = make();
    if (fixtures.replayWindowSeconds === null) {
      t.diagnostic('provedor sem timestamp na assinatura: deduplicação por (provider, event_id) cobre o replay');
      return;
    }
    const old = new Date(now.getTime() - (fixtures.replayWindowSeconds + 60) * 1000);
    const f = fixtures.valid({ eventId: 'evt-old', reference: 'ref', kind: 'CONFIRMED' }, old);
    expectCode(() => provider.verifyWebhook(f.rawBody, f.headers, now), 'SIGNATURE_EXPIRED');
    const fresh = fixtures.valid({ eventId: 'evt-new', reference: 'ref', kind: 'CONFIRMED' }, new Date(now.getTime() - 30_000));
    assert.equal(provider.verifyWebhook(fresh.rawBody, fresh.headers, now).eventId, 'evt-new');
  });

  test(`[${name}] verifyWebhook: payload malformado é recusado com erro tipado (nunca exceção crua)`, () => {
    const { provider, fixtures } = make();
    const f = fixtures.valid({ eventId: 'x', reference: 'ref', kind: 'CONFIRMED' }, now);
    for (const body of ['não é json', '{}', '{"eventId":"","reference":"r","kind":"CONFIRMED"}']) {
      const raw = Buffer.from(body);
      try {
        provider.verifyWebhook(raw, f.headers, now);
        assert.fail(`aceitou payload inválido: ${body}`);
      } catch (e) {
        assert.ok(e instanceof WebhookVerificationError, `erro não tipado para: ${body}`);
      }
    }
  });
}
