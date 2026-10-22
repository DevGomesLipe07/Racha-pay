/// <reference lib="dom" />
// E2E do painel do administrador da plataforma: regra compartilhada com quatro olhos, efeito na API,
// caso do tenant Pessoal resolvido e métricas.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { openTestDb, resetDatabase, type TestDb } from '../integration/helpers.ts';
import { api, startApp, type TestApp } from '../integration/http.ts';
import { DEV_SECRETS } from '../../src/config.ts';

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

async function login(actor: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of 403/.test(m.text())) problems.push(`[${actor}] ${m.text()}`);
  });
  p.on('pageerror', (e) => problems.push(`[${actor}] ${e.message}`));
  await p.goto(`${app.base}/#/admin`);
  await p.getByTestId('admin-token').fill(DEV_SECRETS.ADMIN_TOKEN);
  await p.getByTestId('admin-actor').fill(actor);
  await p.getByTestId('admin-login').click();
  await p.waitForURL(/#\/admin\/regras/);
  return p;
}

test('administração: regra compartilhada com quatro olhos, caso do Pessoal e métricas', { timeout: 120_000 }, async () => {
  const ana = await login('ana');
  await ana.getByTestId('rule-key').selectOption('PAYMENT.EXPIRY');
  await ana.getByTestId('rule-scope').selectOption('SEGMENT');
  await ana.getByTestId('rule-scope-value').fill('TRAVEL');
  await ana.getByTestId('rule-content').fill('{"sandboxMinutes": 60, "manualMinutes": 20160}');
  await ana.getByTestId('rule-rationale').fill('viagem demora mais para acertar');
  await ana.getByTestId('rule-propose').click();
  const row = ana.getByTestId('rule-PAYMENT.EXPIRY').locator('tr', { hasText: 'SEGMENT:TRAVEL' });
  await row.getByText('rascunho').waitFor();
  await row.getByTestId('rule-REVIEW').click();
  await row.getByText('em revisão').waitFor();
  await row.getByTestId('rule-APPROVED').click();
  await ana.getByText(/quatro olhos/).waitFor(); // a própria autora não aprova regra crítica

  const bia = await login('bia');
  const rowB = bia.getByTestId('rule-PAYMENT.EXPIRY').locator('tr', { hasText: 'SEGMENT:TRAVEL' });
  await rowB.getByTestId('rule-APPROVED').click();
  await rowB.getByText('aprovada', { exact: true }).waitFor();
  await rowB.getByTestId('rule-ACTIVE').click();
  await rowB.getByText('ativa', { exact: true }).waitFor();

  const resolved = await api(app, 'GET', '/v1/knowledge/resolve?key=PAYMENT.EXPIRY&segment=TRAVEL', { as: { admin: DEV_SECRETS.ADMIN_TOKEN, actor: 'check' } });
  assert.deepEqual(resolved.body.resolved.content, { sandboxMinutes: 60, manualMinutes: 20160 });

  // Caso do tenant Pessoal: pagamento manual recusado.
  const r = await api(app, 'POST', '/v1/bills', { body: { title: 'Viagem', kind: 'TRAVEL', organizerName: 'Caio', participants: ['Duda'] } });
  const org = { organizer: r.body.organizerToken };
  await api(app, 'POST', `/v1/bills/${r.body.bill.id}/items`, { as: org, body: { description: 'Pousada', unitPriceCents: 20000 } });
  await api(app, 'POST', `/v1/bills/${r.body.bill.id}/splits`, { as: org, body: { expectedTotalCents: 20000 } });
  const p = await api(app, 'POST', '/v1/payments', { as: { share: r.body.shareToken }, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: r.body.bill.id, participantId: r.body.bill.participants[1].id } });
  await api(app, 'POST', `/v1/bills/${r.body.bill.id}/payments/${p.body.payment.id}/reject`, { as: org });

  await bia.getByTestId('admin-tab-casos').click();
  await bia.getByTestId('admin-cases').locator('strong', { hasText: 'MANUAL_PAYMENT_REJECTED' }).waitFor();
  await bia.getByTestId('admin-case-decision').first().fill('NO_ACTION');
  await bia.getByTestId('admin-case-outcome').first().fill('recusa correta do organizador');
  await bia.getByTestId('admin-case-resolve').first().click();
  await bia.getByText('Nenhum caso aberto.').waitFor();

  await bia.getByTestId('admin-tab-metricas').click();
  await bia.getByTestId('admin-metrics').getByText(/rachas quitados/).waitFor();

  assert.deepEqual(problems, []);
});
