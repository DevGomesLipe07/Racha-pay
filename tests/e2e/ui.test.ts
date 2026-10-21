/// <reference lib="dom" />
// E2E da Web/PWA no Chromium: organizador + 2 convidados em celulares simulados, do "criar" ao
// "RACHA QUITADO". Falha se houver erro de console, exceção na página ou violação de CSP.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { openTestDb, resetDatabase, type TestDb } from '../integration/helpers.ts';
import { startApp, type TestApp } from '../integration/http.ts';

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

async function phone(name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'pt-BR' });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`[${name}] console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`[${name}] exceção: ${err.message}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`));
  });
  return { ctx, page };
}

test('fluxo completo pela interface: criar → itens → confirmar → convidados pagam → RACHA QUITADO', { timeout: 120_000 }, async () => {
  const org = await phone('organizador');
  await org.page.goto(app.base);
  await org.page.getByTestId('title').fill('Pizza de sexta');
  await org.page.getByTestId('organizer-name').fill('Ana');
  await org.page.getByTestId('participants').fill('Bruno, Caio');
  await org.page.getByTestId('create').click();
  await org.page.waitForURL(/#\/o\//);

  // Itens: pizza para todos, refrigerante (2×) só para Bruno e Caio, dividido por consumo.
  await org.page.getByTestId('item-desc').fill('Pizza grande');
  await org.page.getByTestId('item-price').fill('90,00');
  await org.page.getByTestId('add-item').click();
  await org.page.getByTestId('items').getByText('Pizza grande').waitFor();
  await org.page.getByTestId('item-desc').fill('Refrigerante');
  await org.page.getByTestId('item-price').fill('12');
  await org.page.getByTestId('item-qty').fill('2');
  await org.page.getByTestId('assign-Bruno').click();
  await org.page.getByTestId('assign-Caio').click();
  await org.page.getByTestId('add-item').click();
  await org.page.getByTestId('items').getByText('Refrigerante').waitFor();
  await org.page.getByTestId('mode').selectOption('BY_ITEM');
  await org.page.waitForFunction(() => (document.querySelector('[data-testid=mode]') as HTMLSelectElement | null)?.value === 'BY_ITEM');

  await org.page.getByTestId('preview-split').click();
  // 114,00 + 10% de serviço = 125,40
  const confirm = org.page.getByTestId('confirm-split');
  await confirm.waitFor();
  assert.match((await confirm.textContent()) ?? '', /125,40/);
  await confirm.click();
  await org.page.getByTestId('state').getByText('Aberta para pagamento').waitFor();
  assert.match((await org.page.getByTestId('total').textContent()) ?? '', /125,40/);
  const shareUrl = ((await org.page.getByTestId('share-link').textContent()) ?? '').trim();
  assert.match(shareUrl, /#\/s\/[0-9a-f-]{36}\/rps_/);
  assert.equal(await org.page.locator('svg.qr rect').count() > 100, true);

  // Bruno: Pix para a Ana (manual) → fica aguardando a confirmação dela.
  const bruno = await phone('bruno');
  await bruno.page.goto(shareUrl);
  await bruno.page.getByTestId('who-Bruno').click();
  assert.match((await bruno.page.getByTestId('my-share').textContent()) ?? '', /46,20/);
  await bruno.page.getByTestId('pay-manual').click();
  await bruno.page.getByTestId('my-status').getByText(/aguardando confirmação/).waitFor();

  // Ana vê o aviso (atualização automática) e confirma que recebeu.
  await org.page.getByTestId('confirm-payment').waitFor({ timeout: 15_000 });
  await org.page.getByTestId('confirm-payment').click();
  await org.page.getByTestId('state').getByText('Parcialmente paga').waitFor();

  // Caio: paga no sandbox (passa pelo webhook assinado).
  const caio = await phone('caio');
  await caio.page.goto(shareUrl);
  await caio.page.getByTestId('who-Caio').click();
  await caio.page.getByTestId('pay-sandbox').click();
  await caio.page.getByTestId('seal').waitFor({ timeout: 15_000 });
  await caio.page.getByTestId('my-status').getByText(/Sua parte está paga/).waitFor();

  // Todos veem o selo; o registro é conferido na tela do organizador.
  await org.page.getByTestId('seal').waitFor({ timeout: 15_000 });
  await org.page.getByTestId('evidence').getByText(/Registro íntegro/).waitFor();
  await bruno.page.reload();
  await bruno.page.getByTestId('seal').waitFor();
  await bruno.page.getByTestId('my-status').getByText(/Sua parte está paga/).waitFor();

  // O token nunca aparece em requisição como query string nem em Referer.
  assert.equal(new URL(shareUrl).search, '');

  for (const c of [org, bruno, caio]) await c.ctx.close();
  assert.deepEqual(problems, []);
});
