import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTenant, inScope, openTestDb, PERSONAL_TENANT, resetDatabase, type TestDb } from './helpers.ts';
import { api, createApiKey, startApp, type TestApp } from './http.ts';
import { DEV_SECRETS } from '../../src/config.ts';

let db: TestDb;
let app: TestApp;

before(async () => {
  await resetDatabase();
  db = await openTestDb();
  app = await startApp(db);
});
after(async () => {
  await app?.close();
  await db?.close();
});

async function newPersonalBill(title = 'Pizzaria', participants = ['Bruno', 'Caio']) {
  const r = await api(app, 'POST', '/v1/bills', { body: { kind: 'RESTAURANT', title, organizerName: 'Ana', participants } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const bill = r.body.bill;
  const [ana, bruno, caio] = bill.participants as { id: string; name: string }[];
  return { id: bill.id as string, org: { organizer: r.body.organizerToken as string }, guest: { share: r.body.shareToken as string }, ana, bruno, caio, body: r.body };
}

test('criar conta sem cadastro: organizador, links com token no #, serviço de 10% do restaurante', async () => {
  const b = await newPersonalBill();
  assert.equal(b.body.bill.state, 'DRAFT');
  assert.equal(b.body.bill.collectionModel, 'ORGANIZER_COLLECTS');
  assert.equal(b.body.bill.serviceBp, 1000);
  assert.equal(b.ana?.name, 'Ana');
  assert.equal(b.body.bill.participants[0].isOrganizer, true);
  assert.match(b.body.organizerToken, /^rpo_/);
  assert.match(b.body.links.share, new RegExp(`/#/s/${b.id}/rps_`));
  assert.match(b.body.links.organizer, new RegExp(`/#/o/${b.id}/rpo_`));
});

test('fluxo: itens por consumo → prévia → prévia desatualizada recusada → confirmar → OPEN com parte do organizador quitada', async () => {
  const b = await newPersonalBill();
  const add = (description: string, unitPriceCents: number, who: string[], quantity = 1) =>
    api(app, 'POST', `/v1/bills/${b.id}/items`, { as: b.org, body: { description, unitPriceCents, quantity, assignees: who.map((participantId) => ({ participantId })) } });
  assert.equal((await add('Pizza grande', 9000, [])).status, 201);
  assert.equal((await add('Refrigerante', 800, [b.bruno!.id, b.caio!.id], 2)).status, 201);
  assert.equal((await add('Sobremesa', 1500, [b.ana!.id])).status, 201);
  assert.equal((await api(app, 'PATCH', `/v1/bills/${b.id}`, { as: b.org, body: { splitMode: 'BY_ITEM' } })).status, 200);

  const preview = await api(app, 'POST', `/v1/bills/${b.id}/splits/preview`, { as: b.org });
  assert.equal(preview.status, 200);
  // subtotal 9000 + 1600 + 1500 = 12100; serviço 10% = 1210; total 13310
  assert.equal(preview.body.preview.totals.subtotalCents, 12100);
  assert.equal(preview.body.preview.totals.serviceCents, 1210);
  assert.equal(preview.body.preview.totals.totalCents, 13310);
  const shares = preview.body.preview.shares.map((s: { totalCents: number }) => s.totalCents);
  assert.equal(shares.reduce((a: number, x: number) => a + x, 0), 13310);
  // Ana: 3000 + 1500 = 4500 de consumo; Bruno/Caio: 3000 + 800 = 3800 cada → ×1,1
  assert.deepEqual(shares, [4950, 4180, 4180]);
  assert.ok(preview.body.preview.rules.some((r: { key: string; scope: string }) => r.key === 'SERVICE_CHARGE.DEFAULT' && r.scope === 'SEGMENT:RESTAURANT'));

  const stale = await api(app, 'POST', `/v1/bills/${b.id}/splits`, { as: b.org, body: { expectedTotalCents: 13000 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'STALE_PREVIEW');

  const ok = await api(app, 'POST', `/v1/bills/${b.id}/splits`, { as: b.org, body: { expectedTotalCents: 13310 } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.splitVersion, 1);
  assert.equal(ok.body.bill.state, 'OPEN');
  const ana = ok.body.bill.participants.find((p: { isOrganizer: boolean }) => p.isOrganizer);
  assert.equal(ana.balance.settled, true);
  assert.equal(ana.balance.selfSettledCents, 4950);
  assert.equal(ok.body.bill.reconciliation.unassignedCents, 0);
  assert.equal(ok.body.bill.reconciliation.paidCents, 4950);

  // Depois de confirmada: dinheiro travado, item confirmado imutável.
  const lockedPatch = await api(app, 'PATCH', `/v1/bills/${b.id}`, { as: b.org, body: { discountCents: 100 } });
  assert.equal(lockedPatch.body.error.code, 'SPLIT_LOCKED');
  const itemId = ok.body.bill.items[0].id;
  assert.equal((await api(app, 'DELETE', `/v1/bills/${b.id}/items/${itemId}`, { as: b.org })).body.error.code, 'ITEM_CONFIRMED');
  assert.equal((await api(app, 'DELETE', `/v1/bills/${b.id}/participants/${b.bruno!.id}`, { as: b.org })).body.error.code, 'SPLIT_LOCKED');

  // D2 — mais uma rodada: complemento só do acréscimo.
  assert.equal((await add('Mais refrigerante', 800, [b.bruno!.id])).status, 201);
  const comp = await api(app, 'POST', `/v1/bills/${b.id}/splits/preview`, { as: b.org });
  assert.equal(comp.body.preview.kind, 'COMPLEMENT');
  assert.equal(comp.body.preview.step.totalCents, 880);
  assert.equal(comp.body.preview.totals.totalCents, 14190);
  const confirmed2 = await api(app, 'POST', `/v1/bills/${b.id}/splits`, { as: b.org, body: { expectedTotalCents: 14190 } });
  assert.equal(confirmed2.status, 201, JSON.stringify(confirmed2.body));
  assert.equal(confirmed2.body.splitVersion, 2);
  const bruno = confirmed2.body.bill.participants.find((p: { id: string }) => p.id === b.bruno!.id);
  assert.equal(bruno.share.totalCents, 4180 + 880);
  const nothing = await api(app, 'POST', `/v1/bills/${b.id}/splits`, { as: b.org, body: { expectedTotalCents: 14190 } });
  assert.equal(nothing.body.error.code, 'NOTHING_TO_CONFIRM');

  // Ledger: cadeia válida e reconstrução só pelo ledger bate com o banco.
  const ledger = await api(app, 'GET', `/v1/bills/${b.id}/ledger`, { as: b.guest });
  assert.equal(ledger.status, 200);
  assert.equal(ledger.body.verification.valid, true);
  assert.equal(ledger.body.reconstruction.consistent, true);
  assert.deepEqual(
    ledger.body.entries.map((e: { type: string }) => e.type),
    ['BILL_CREATED', 'SPLIT_CONFIRMED', 'ORGANIZER_SHARE_SELF_SETTLED', 'BILL_STATE_CHANGED', 'SPLIT_COMPLEMENTED', 'ORGANIZER_SHARE_SELF_SETTLED'],
  );

  const recon = await api(app, 'GET', `/v1/bills/${b.id}/reconciliation`, { as: b.guest });
  assert.equal(recon.body.totalCents, 14190);
  assert.equal(recon.body.paidCents + recon.body.processingCents + recon.body.assignedUnpaidCents + recon.body.unassignedCents - recon.body.excessCents, 14190);
});

test('destravar sem pagamentos volta a rascunho; cancelar é terminal', async () => {
  const b = await newPersonalBill();
  await api(app, 'POST', `/v1/bills/${b.id}/items`, { as: b.org, body: { description: 'Corrida', unitPriceCents: 3000 } });
  const prev = await api(app, 'POST', `/v1/bills/${b.id}/splits/preview`, { as: b.org });
  await api(app, 'POST', `/v1/bills/${b.id}/splits`, { as: b.org, body: { expectedTotalCents: prev.body.preview.totals.totalCents } });
  const unlocked = await api(app, 'POST', `/v1/bills/${b.id}/splits/unlock`, { as: b.org });
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.body.bill.state, 'DRAFT');
  assert.equal(unlocked.body.bill.items[0].confirmedVersion, null);
  assert.equal((await api(app, 'PATCH', `/v1/bills/${b.id}`, { as: b.org, body: { serviceBp: 0 } })).status, 200);
  assert.equal((await api(app, 'PATCH', `/v1/bills/${b.id}`, { as: b.org, body: { serviceBp: 3001 } })).body.error.code, 'SERVICE_BP_OUT_OF_RANGE');

  const cancelled = await api(app, 'POST', `/v1/bills/${b.id}/cancel`, { as: b.org, body: {} });
  assert.equal(cancelled.body.bill.state, 'CANCELLED');
  assert.equal((await api(app, 'POST', `/v1/bills/${b.id}/participants`, { as: b.org, body: { name: 'X' } })).body.error.code, 'BILL_CANCELLED');
});

test('convidado vê a conta mas não edita; negação fica no audit_log', async () => {
  const b = await newPersonalBill();
  assert.equal((await api(app, 'GET', `/v1/bills/${b.id}`, { as: b.guest })).body.bill.viewer, 'guest');
  const denied = await api(app, 'PATCH', `/v1/bills/${b.id}`, { as: b.guest, body: { title: 'invadido' } });
  assert.equal(denied.status, 403);
  assert.equal((await api(app, 'POST', `/v1/bills/${b.id}/splits`, { as: b.guest, body: { expectedTotalCents: 0 } })).status, 403);
  const audit = await inScope(db, { kind: 'tenant', tenantId: PERSONAL_TENANT }, (c) =>
    c.query("SELECT action, allowed FROM audit_log WHERE bill_id = $1 AND NOT allowed ORDER BY created_at", [b.id]),
  );
  assert.deepEqual(audit.rows.map((r) => r.action), ['bill.edit', 'split.confirm']);
});

test('token de uma conta não abre outra (404); token inválido (401)', async () => {
  const a = await newPersonalBill('A');
  const b = await newPersonalBill('B');
  assert.equal((await api(app, 'GET', `/v1/bills/${b.id}`, { as: a.org })).status, 404);
  assert.equal((await api(app, 'GET', `/v1/bills/${b.id}`, { as: a.guest })).status, 404);
  assert.equal((await api(app, 'GET', `/v1/bills/${a.id}`, { as: { organizer: 'rpo_' + 'x'.repeat(43) } })).status, 401);
  assert.equal((await api(app, 'GET', `/v1/bills/${a.id}`, { as: { share: a.org.organizer } })).status, 401);
  assert.equal((await api(app, 'GET', `/v1/bills/${a.id}`)).status, 401);
});

test('chave de API (Business): conta MERCHANT_COLLECTS, escopo do tenant, isolamento entre tenants', async () => {
  const t1 = await createTenant(db, 'Restaurante 1');
  const t2 = await createTenant(db, 'Restaurante 2');
  const k1 = await createApiKey(db, t1, ['bills:read', 'bills:write']);
  const k2 = await createApiKey(db, t2, ['bills:read', 'bills:write']);
  const created = await api(app, 'POST', '/v1/bills', { as: { key: k1, actor: 'garcom-7' }, body: { kind: 'RESTAURANT', title: 'Mesa 12', tableLabel: '12', participants: ['Cliente 1', 'Cliente 2'] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.bill.collectionModel, 'MERCHANT_COLLECTS');
  assert.equal(created.body.organizerToken, undefined);
  const id = created.body.bill.id;
  assert.equal((await api(app, 'GET', `/v1/bills/${id}`, { as: { key: k1 } })).status, 200);
  assert.equal((await api(app, 'GET', `/v1/bills/${id}`, { as: { key: k2 } })).status, 404);
  const readOnly = await createApiKey(db, t1, ['bills:read']);
  assert.equal((await api(app, 'PATCH', `/v1/bills/${id}`, { as: { key: readOnly }, body: { title: 'x' } })).status, 403);
  const ai = await createApiKey(db, t1, ['*'], 'AI');
  const aiConfirm = await api(app, 'POST', `/v1/bills/${id}/splits`, { as: { key: ai }, body: { expectedTotalCents: 0 } });
  assert.equal(aiConfirm.status, 403);
  assert.match(aiConfirm.body.error.message, /IA não executa/);
});

test('HTTP: headers de segurança, envelope de erro, JSON inválido, tipo errado, rota inexistente', async () => {
  const health = await api(app, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.doesNotMatch(health.headers.get('content-security-policy') ?? '', /unsafe-inline/);
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.equal((await api(app, 'GET', '/ready')).status, 200);

  const missing = await api(app, 'GET', '/v1/nada');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  assert.ok(missing.body.error.correlationId);

  const badJson = await fetch(`${app.base}/v1/bills`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(badJson.status, 400);
  const wrongType = await fetch(`${app.base}/v1/bills`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'oi' });
  assert.equal(wrongType.status, 415);
  const invalid = await api(app, 'POST', '/v1/bills', { body: { title: '', extra: 1 } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  assert.equal((await api(app, 'POST', '/v1/bills', { body: { title: 'x', organizerName: 'A', collectionModel: 'MERCHANT_COLLECTS' } })).status, 403);
  const echoed = await api(app, 'GET', '/health', { headers: { 'x-correlation-id': 'meu-id-123456' } });
  assert.equal(echoed.headers.get('x-correlation-id'), 'meu-id-123456');
});

test('organizador emite novo link de convidado; convidado não emite; o antigo continua valendo', async () => {
  const b = await newPersonalBill();
  const r = await api(app, 'POST', `/v1/bills/${b.id}/share-links`, { as: b.org });
  assert.equal(r.status, 201);
  assert.match(r.body.shareToken, /^rps_/);
  assert.match(r.body.links.share, new RegExp(`/#/s/${b.id}/rps_`));
  assert.equal((await api(app, 'GET', `/v1/bills/${b.id}`, { as: { share: r.body.shareToken } })).status, 200);
  assert.equal((await api(app, 'GET', `/v1/bills/${b.id}`, b.guest ? { as: b.guest } : {})).status, 200);
  assert.equal((await api(app, 'POST', `/v1/bills/${b.id}/share-links`, { as: b.guest })).status, 403);
});

test('Web/PWA: serve o app com CSP estrita e não sai da pasta public', async () => {
  const home = await fetch(`${app.base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') ?? '', /text\/html/);
  assert.match(home.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const html = await home.text();
  assert.doesNotMatch(html, /<script>|style=/, 'sem script nem estilo inline');
  assert.equal((await fetch(`${app.base}/app.js`)).status, 200);
  assert.equal((await fetch(`${app.base}/vendor/qrcode.mjs`)).status, 200);
  for (const evil of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/.env', '/../src/config.ts', '/vendor/../../package.json']) {
    const res = await fetch(`${app.base}${evil}`);
    assert.notEqual(res.status, 200, evil);
  }
});

test('/metrics: só com token de administrador; rótulos usam o padrão da rota, nunca ids', async () => {
  const b = await newPersonalBill();
  await api(app, 'GET', `/v1/bills/${b.id}`, { as: b.org });
  assert.equal((await fetch(`${app.base}/metrics`)).status, 401);
  assert.equal((await fetch(`${app.base}/metrics`, { headers: { authorization: 'Bearer errado' } })).status, 401);
  const res = await fetch(`${app.base}/metrics`, { headers: { authorization: `Bearer ${DEV_SECRETS.ADMIN_TOKEN}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  const text = await res.text();
  assert.match(text, /rachapay_http_requests_total\{route="GET \/v1\/bills\/:id",status="200"\} \d+/);
  assert.match(text, /rachapay_db_pool_connections\{state="total"\}/);
  assert.equal(text.includes(b.id), false, 'id da conta não vaza nas métricas');
  assert.equal(text.includes('rpo_'), false);
});

test('D11: criação anônima é limitada por cliente (429 + Retry-After)', async () => {
  const limited = await startApp(db);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await api(limited, 'POST', '/v1/bills', { body: { title: `x${i}`, organizerName: 'A' } })).status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
    assert.equal(statuses[10], 429);
    const r = await api(limited, 'POST', '/v1/bills', { body: { title: 'y', organizerName: 'A' } });
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    limited.clock.advance(61_000);
    assert.equal((await api(limited, 'POST', '/v1/bills', { body: { title: 'z', organizerName: 'A' } })).status, 201);
  } finally {
    await limited.close();
  }
});
