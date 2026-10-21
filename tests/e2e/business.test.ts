/// <reference lib="dom" />
// E2E do painel do estabelecimento: login com chave de operador → abrir mesa → itens → confirmar →
// cliente paga no caixa pelo link da mesa → operador confirma → casos, webhooks e conciliação do dia.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { createTenant, openTestDb, resetDatabase, type TestDb } from '../integration/helpers.ts';
import { api, createApiKey, startApp, type TestApp } from '../integration/http.ts';

let db: TestDb;
let app: TestApp;
let browser: Browser;
const problems: string[] = [];

before(async () => {
  await resetDatabase();
  db = await openTestDb();
  app = await startApp(db);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await app?.close();
  await db?.close();
});

async function page(name: string, mobile: boolean): Promise<Page> {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${name}] ${m.text()}`);
  });
  p.on('pageerror', (e) => problems.push(`[${name}] ${e.message}`));
  await p.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP: ${e.violatedDirective}`)));
  return p;
}

test('painel do estabelecimento ponta a ponta', { timeout: 120_000 }, async () => {
  const tenantId = await createTenant(db, 'Bar do Zé');
  const key = await createApiKey(db, tenantId, ['bills:read', 'bills:write', 'payments:create', 'payments:write', 'establishments:write', 'erp:sync', 'webhooks:write', 'metrics:read', 'cbr:read', 'cbr:write'], 'HUMAN');
  await api(app, 'POST', '/v1/establishments', { as: { key }, body: { externalId: 'centro', name: 'Bar do Zé — Centro' } });

  const op = await page('operador', false);
  await op.goto(`${app.base}/#/b`);
  await op.getByTestId('biz-key').fill('rpk_curta');
  await op.getByTestId('biz-actor').fill('caixa-ze');
  await op.getByTestId('biz-login').click();
  await op.getByText('chave inválida').waitFor();
  await op.getByTestId('biz-key').fill(key);
  await op.getByTestId('biz-login').click();
  await op.waitForURL(/#\/b\/mesas/);

  // Abrir mesa 12 com duas pessoas e lançar a conta.
  await op.getByTestId('biz-table').fill('12');
  await op.getByTestId('biz-people').fill('Ana, Bruno');
  await op.getByTestId('biz-open').click();
  await op.waitForURL(/#\/b\/m\//);
  await op.getByTestId('item-desc').fill('Porção de fritas');
  await op.getByTestId('item-price').fill('40,00');
  await op.getByTestId('add-item').click();
  await op.getByTestId('items').getByText('Porção de fritas').waitFor();
  await op.getByTestId('preview-split').click();
  await op.getByTestId('confirm-split').waitFor();
  assert.match((await op.getByTestId('confirm-split').textContent()) ?? '', /44,00/);
  await op.getByTestId('confirm-split').click();
  await op.getByTestId('state').getByText('Aberta para pagamento').waitFor();
  const shareUrl = ((await op.getByTestId('share-link').textContent()) ?? '').trim();
  assert.match(shareUrl, /#\/s\//);

  // Cliente pelo QR da mesa: avisa que pagou no caixa.
  const cliente = await page('cliente', true);
  await cliente.goto(shareUrl);
  await cliente.getByTestId('who-Ana').click();
  assert.match((await cliente.getByTestId('my-share').textContent()) ?? '', /22,00/);
  await cliente.getByTestId('pay-manual').click();
  await cliente.getByTestId('my-status').getByText(/aguardando confirmação/).waitFor();

  // Operador vê o aviso na mesa e confirma; a lista de mesas mostra a mesa aberta.
  await op.getByTestId('confirm-payment').waitFor({ timeout: 15_000 });
  await op.getByTestId('confirm-payment').click();
  await op.getByTestId('state').getByText('Parcialmente paga').waitFor();
  await op.getByTestId('tab-mesas').click();
  await op.getByTestId('biz-bill-12').waitFor();

  // Divergência vinda do ERP aparece em Casos e é resolvida pelo operador.
  await api(app, 'POST', '/v1/integrations/erp/generic/sync', {
    as: { key },
    body: { externalReference: 'cmd-1', establishmentExternalId: 'centro', tableLabel: '30', participants: ['X'], items: [{ externalRef: 'i1', description: 'Prato', unitPriceCents: 3000, quantity: 1 }] },
  });
  const list = await api(app, 'GET', '/v1/bills?open=true', { as: { key } });
  const m30 = list.body.bills.find((b: { tableLabel: string }) => b.tableLabel === '30');
  await api(app, 'POST', `/v1/bills/${m30.id}/splits`, { as: { key }, body: { expectedTotalCents: 3300 } });
  const div = await api(app, 'POST', '/v1/integrations/erp/generic/sync', {
    as: { key },
    body: { externalReference: 'cmd-1', establishmentExternalId: 'centro', tableLabel: '30', items: [{ externalRef: 'i1', description: 'Prato', unitPriceCents: 1, quantity: 1 }] },
  });
  assert.equal(div.status, 409);
  await op.getByTestId('tab-casos').click();
  await op.getByTestId('biz-cases').getByText('ERP_DIVERGENCE').waitFor();
  await op.getByTestId('case-decision').first().fill('KEEP_CONFIRMED');
  await op.getByTestId('case-outcome').first().fill('ERP corrigido manualmente');
  await op.getByRole('button', { name: 'Resolver' }).first().click();
  await op.getByText('Nenhum caso aberto.').waitFor();

  await op.getByTestId('tab-webhooks').click();
  await op.getByTestId('biz-deliveries').waitFor();

  await op.getByTestId('tab-dia').click();
  await op.getByTestId('biz-daily').getByText('Bar do Zé — Centro').waitFor();
  assert.match((await op.getByTestId('biz-daily').textContent()) ?? '', /22,00/);

  assert.deepEqual(problems, []);
});
