import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createTenant, openTestDb, PERSONAL_TENANT, resetDatabase, type TestDb } from './helpers.ts';
import { api, createApiKey, startApp, type TestApp } from './http.ts';
import { DEV_SECRETS } from '../../src/config.ts';

let db: TestDb;
let app: TestApp;
let aiApp: TestApp;
let fake: Server;
const calls: { path: string; headers: Record<string, string | string[] | undefined>; body: any }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

// 1×1 PNG válido (bytes mágicos reais).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function message(content: unknown, stop_reason = 'end_turn') {
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify(content) }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 80 },
  };
}

before(async () => {
  await resetDatabase();
  db = await openTestDb();
  app = await startApp(db);
  fake = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push({ path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(reply.status, { 'content-type': 'application/json', 'request-id': 'req_test' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  aiApp = await startApp(db, {
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-teste-falso',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
  });
});
after(async () => {
  await aiApp?.close();
  await app?.close();
  await new Promise((r) => fake?.close(r));
  await db?.close();
});

async function personalBill(target: TestApp = app) {
  const r = await api(target, 'POST', '/v1/bills', { body: { kind: 'RESTAURANT', title: 'Bar', organizerName: 'Ana', participants: ['Bruno'] } });
  return { id: r.body.bill.id as string, org: { organizer: r.body.organizerToken as string }, guest: { share: r.body.shareToken as string }, bruno: r.body.bill.participants[1].id as string };
}

test('cupom em texto: sugestão sem gravar nada; convidado também pode sugerir', async () => {
  const b = await personalBill();
  const r = await api(app, 'POST', `/v1/bills/${b.id}/receipt`, { as: b.org, body: { text: 'PICANHA 89,90\n2 x CHOPP 24,00\nTOTAL 113,90' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.suggestion.items.length, 2);
  assert.equal(r.body.suggestion.requiresConfirmation, true);
  assert.equal((await api(app, 'GET', `/v1/bills/${b.id}`, { as: b.org })).body.bill.items.length, 0, 'nada foi gravado');
  assert.equal((await api(app, 'POST', `/v1/bills/${b.id}/receipt`, { as: b.guest, body: { text: 'X 1,00' } })).status, 200);
});

test('foto sem IA ligada → 501 com caminho manual; imagem com tipo falso → 422', async () => {
  const b = await personalBill();
  const off = await api(app, 'POST', `/v1/bills/${b.id}/receipt`, { as: b.org, body: { image: { mediaType: 'image/png', data: PNG } } });
  assert.equal(off.status, 501);
  assert.equal(off.body.error.code, 'AI_DISABLED');
  const fakeJpeg = await api(aiApp, 'POST', `/v1/bills/${b.id}/receipt`, { as: b.org, body: { image: { mediaType: 'image/jpeg', data: PNG } } });
  assert.equal(fakeJpeg.body.error.code, 'INVALID_IMAGE');
});

test('foto com IA (adapter Anthropic contra servidor falso): request correto, saída validada, valores revalidados', async () => {
  const b = await personalBill(aiApp);
  calls.length = 0;
  reply = {
    status: 200,
    body: message({
      items: [
        { description: 'Picanha', quantity: 1, unitPriceCents: 8990 },
        { description: 'Chopp', quantity: 2, unitPriceCents: 1200 },
        { description: 'Valor estranho', quantity: 1, unitPriceCents: -5 },
      ],
      printedTotalCents: 11390,
      notes: ['uma linha borrada'],
    }),
  };
  const r = await api(aiApp, 'POST', `/v1/bills/${b.id}/receipt`, { as: b.org, body: { image: { mediaType: 'image/png', data: PNG } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.suggestion;
  assert.equal(s.source, 'AI:anthropic:claude-sonnet-5-5');
  assert.deepEqual(s.items.map((i: { description: string; unitPriceCents: number }) => [i.description, i.unitPriceCents]), [['Picanha', 8990], ['Chopp', 1200]]);
  assert.ok(s.warnings.some((w: string) => /descartado/.test(w)));
  assert.ok(s.warnings.includes('uma linha borrada'));
  assert.equal(s.requiresConfirmation, true);

  const call = calls[0]!;
  assert.match(call.path, /\/v1\/messages/);
  assert.equal(call.headers['x-api-key'], 'sk-ant-teste-falso');
  assert.ok(call.headers['anthropic-version']);
  assert.match(String(call.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.equal(call.body.model, 'claude-sonnet-5-5');
  assert.equal(call.body.fallbacks, 'default');
  assert.equal(call.body.output_config.format.type, 'json_schema');
  assert.equal(call.body.output_config.effort, 'medium');
  assert.equal(call.body.messages[0].content[0].type, 'image');
  assert.equal(call.body.messages[0].content[0].source.data, PNG);
  assert.equal((await api(aiApp, 'GET', `/v1/bills/${b.id}`, { as: b.org })).body.bill.items.length, 0, 'IA não grava na conta');
});

test('IA recusa ou falha → erro claro (503), núcleo segue funcionando', async () => {
  const b = await personalBill(aiApp);
  reply = { status: 200, body: { ...message({ items: [], printedTotalCents: null, notes: [] }), stop_reason: 'refusal' } };
  const refused = await api(aiApp, 'POST', `/v1/bills/${b.id}/receipt`, { as: b.org, body: { image: { mediaType: 'image/png', data: PNG } } });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'AI_REFUSED');
  reply = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad image' } } };
  const bad = await api(aiApp, 'POST', `/v1/bills/${b.id}/receipt`, { as: b.org, body: { image: { mediaType: 'image/png', data: PNG } } });
  assert.equal(bad.status, 503);
  assert.equal(bad.body.error.code, 'AI_BAD_REQUEST');
  // O resto da conta continua funcionando normalmente.
  assert.equal((await api(aiApp, 'POST', `/v1/bills/${b.id}/items`, { as: b.org, body: { description: 'Pizza', unitPriceCents: 5000 } })).status, 201);
});

test('explicação da conciliação e manifesto de skills', async () => {
  const b = await personalBill();
  await api(app, 'POST', `/v1/bills/${b.id}/items`, { as: b.org, body: { description: 'Pizza', unitPriceCents: 10000 } });
  const pv = await api(app, 'POST', `/v1/bills/${b.id}/splits/preview`, { as: b.org });
  await api(app, 'POST', `/v1/bills/${b.id}/splits`, { as: b.org, body: { expectedTotalCents: pv.body.preview.totals.totalCents } });
  const ex = await api(app, 'GET', `/v1/bills/${b.id}/explanation`, { as: b.guest });
  assert.equal(ex.status, 200);
  assert.equal(ex.body.usesAI, false);
  assert.ok(ex.body.explanation.some((l: string) => /Ana organizou/.test(l)));
  assert.ok(ex.body.explanation.some((l: string) => /Bruno deve R\$ 55,00/.test(l)));
  const skills = await api(app, 'GET', '/v1/skills');
  assert.equal(skills.body.aiProvider, 'none');
  assert.equal(skills.body.skills.length, 2);
});

test('métricas North Star: quitados, conclusão, mediana, volume declarado × teste, exceções', async () => {
  const tenantId = await createTenant(db, 'Bar Métricas');
  const sys = { key: await createApiKey(db, tenantId, ['bills:read', 'bills:write', 'payments:create', 'metrics:read']) };
  const cashier = { key: await createApiKey(db, tenantId, ['bills:read', 'payments:write'], 'HUMAN'), actor: 'caixa' };
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const bill = await api(app, 'POST', '/v1/bills', { as: sys, body: { kind: 'OTHER', title: `Mesa ${i}`, participants: ['A', 'B'] } });
    const id = bill.body.bill.id;
    ids.push(id);
    await api(app, 'POST', `/v1/bills/${id}/items`, { as: sys, body: { description: 'Rodada', unitPriceCents: 10000 } });
    await api(app, 'POST', `/v1/bills/${id}/splits`, { as: sys, body: { expectedTotalCents: 10000 } });
  }
  // Mesa 0 quita: A por manual (declarado), B por sandbox (teste), 30 minutos depois.
  const [a, bp] = (await api(app, 'GET', `/v1/bills/${ids[0]}`, { as: sys })).body.bill.participants.map((p: { id: string }) => p.id);
  app.clock.advance(30 * 60_000);
  const m = await api(app, 'POST', '/v1/payments', { as: sys, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: ids[0], participantId: a } });
  await api(app, 'POST', `/v1/bills/${ids[0]}/payments/${m.body.payment.id}/confirm`, { as: cashier });
  const sb = await api(app, 'POST', '/v1/payments', { as: sys, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: ids[0], participantId: bp, method: 'SANDBOX' } });
  const hook = app.sandbox.buildWebhook({ eventId: `m-${randomUUID()}`, reference: sb.body.payment.sandbox.reference, kind: 'CONFIRMED' }, app.clock.now());
  await fetch(`${app.base}/v1/webhooks/payments/sandbox`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sandbox-signature': hook.signature }, body: hook.body });
  // Mesa 1: recusa manual → exceção registrada.
  const [a1] = (await api(app, 'GET', `/v1/bills/${ids[1]}`, { as: sys })).body.bill.participants.map((p: { id: string }) => p.id);
  const r1 = await api(app, 'POST', '/v1/payments', { as: sys, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: ids[1], participantId: a1 } });
  await api(app, 'POST', `/v1/bills/${ids[1]}/payments/${r1.body.payment.id}/reject`, { as: cashier });

  const res = await api(app, 'GET', '/v1/metrics?month=2026-10', { as: sys });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const mt = res.body.metrics;
  assert.equal(mt.settledBills, 1);
  assert.equal(mt.confirmedBills, 2);
  assert.equal(mt.completionRate, 0.5);
  assert.equal(mt.averageParticipants, 2);
  assert.equal(mt.medianMinutesToSettle, 30);
  assert.deepEqual(mt.volume, { declaredManualCents: 5000, sandboxTestCents: 5000, providerCents: 0 });
  assert.deepEqual(mt.exceptions, { MANUAL_PAYMENT_REJECTED: 1 });
  assert.equal((await api(app, 'GET', '/v1/metrics?month=2026-09', { as: sys })).body.metrics.settledBills, 0);

  const personal = await personalBill();
  assert.equal((await api(app, 'GET', '/v1/metrics', { as: personal.org })).status, 403);
  const adminAs = { admin: DEV_SECRETS.ADMIN_TOKEN, actor: 'ops' };
  assert.equal((await api(app, 'GET', '/v1/metrics', { as: adminAs })).body.error.code, 'TENANT_REQUIRED');
  assert.equal((await api(app, 'GET', `/v1/metrics?tenantId=${PERSONAL_TENANT}&month=2026-10`, { as: adminAs })).status, 200);
  assert.equal((await api(app, 'GET', '/v1/metrics?month=2026-13', { as: sys })).body.error.code, 'INVALID_MONTH');
});
