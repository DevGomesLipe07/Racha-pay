import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, policyFor, validateEndpointUrl, DestinationError } from '../../src/modules/integrations/webhooks/ssrf.ts';
import { nextDelaySeconds, signWebhook } from '../../src/modules/integrations/webhooks/delivery.ts';
import { webhookTypeFor } from '../../src/modules/integrations/webhooks/outbox.ts';
import { hmacSha256Hex } from '../../src/infra/crypto/hash.ts';

test('SSRF: endereços privados, loopback, link-local, metadados e IPv6 locais são bloqueados', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'não-é-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('SSRF: em produção exige https e recusa host interno; em dev permite localhost', () => {
  const prod = policyFor('production');
  const code = (url: string) => {
    try {
      validateEndpointUrl(url, prod);
      return 'OK';
    } catch (e) {
      return (e as DestinationError).code;
    }
  };
  assert.equal(code('https://erp.exemplo.com.br/hooks'), 'OK');
  assert.equal(code('http://erp.exemplo.com.br/hooks'), 'HTTPS_REQUIRED');
  assert.equal(code('https://localhost/x'), 'PRIVATE_DESTINATION');
  assert.equal(code('https://10.1.2.3/x'), 'PRIVATE_DESTINATION');
  assert.equal(code('https://[::1]/x'), 'PRIVATE_DESTINATION');
  assert.equal(code('https://user:pass@erp.exemplo.com.br/'), 'INVALID_URL');
  assert.equal(code('ftp://erp.exemplo.com.br/'), 'INVALID_URL');
  assert.doesNotThrow(() => validateEndpointUrl('http://127.0.0.1:9999/hook', policyFor('development')));
});

test('D17: 12 tentativas, 10 s dobrando — janela total ≈ 5,7 h, depois DEAD', () => {
  const rule = { maxAttempts: 12, baseSeconds: 10, maxIntervalSeconds: 21_600 };
  const delays: number[] = [];
  for (let attempt = 1; attempt <= 12; attempt++) {
    const d = nextDelaySeconds(attempt, rule);
    if (d !== null) delays.push(d);
  }
  assert.deepEqual(delays.slice(0, 4), [10, 20, 40, 80]);
  assert.equal(delays.length, 11);
  assert.equal(nextDelaySeconds(12, rule), null);
  const total = delays.reduce((a, b) => a + b, 0);
  assert.equal(total, 20_470);
  assert.ok(total / 3600 > 5.6 && total / 3600 < 5.8);
  assert.equal(nextDelaySeconds(5, { maxAttempts: 30, baseSeconds: 3600, maxIntervalSeconds: 21_600 }), 21_600);
});

test('assinatura: t=<unix>,v1=HMAC(segredo, "<t>.<corpo>")', () => {
  const sig = signWebhook('whsec_x', '{"a":1}', 1_700_000_000);
  assert.equal(sig, `t=1700000000,v1=${hmacSha256Hex('whsec_x', '1700000000.{"a":1}')}`);
});

test('ledger → webhook: tipos mapeados e estados relevantes', () => {
  assert.equal(webhookTypeFor({ type: 'PAYMENT_CONFIRMED', payload: {} }), 'payment.confirmed');
  assert.equal(webhookTypeFor({ type: 'PAYMENT_EXPIRED', payload: {} }), 'payment.failed');
  assert.equal(webhookTypeFor({ type: 'SPLIT_COMPLEMENTED', payload: {} }), 'split.confirmed');
  assert.equal(webhookTypeFor({ type: 'BILL_STATE_CHANGED', payload: { to: 'SETTLED' } }), 'bill.settled');
  assert.equal(webhookTypeFor({ type: 'BILL_STATE_CHANGED', payload: { to: 'SETTLEMENT_PENDING' } }), undefined);
  assert.equal(webhookTypeFor({ type: 'ORGANIZER_SHARE_SELF_SETTLED', payload: {} }), undefined);
});
