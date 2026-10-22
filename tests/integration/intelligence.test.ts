import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, inScope, openTestDb, resetDatabase, sqlError, type TestDb } from './helpers.ts';
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

const admin = (actor: string) => ({ admin: DEV_SECRETS.ADMIN_TOKEN, actor });

async function tenantWithKeys() {
  const tenantId = await createTenant(db, `Rede ${randomUUID().slice(0, 6)}`);
  const all = ['bills:read', 'bills:write', 'payments:create', 'payments:write', 'knowledge:read', 'knowledge:write', 'knowledge:approve', 'cbr:read', 'cbr:write'];
  return {
    tenantId,
    system: { key: await createApiKey(db, tenantId, all, 'SYSTEM') },
    ana: { key: await createApiKey(db, tenantId, all, 'HUMAN'), actor: 'gerente-ana' },
    bia: { key: await createApiKey(db, tenantId, all, 'HUMAN'), actor: 'gerente-bia' },
    ai: { key: await createApiKey(db, tenantId, ['*'], 'AI') },
  };
}

test('governança: proposta validada por schema, quatro olhos, ativação muda o comportamento do engine e substitui a anterior', async () => {
  const t = await tenantWithKeys();
  const bad = await api(app, 'POST', '/v1/knowledge', { as: t.ana, body: { key: 'SERVICE_CHARGE.DEFAULT', scopeType: 'TENANT', content: { bp: 4000, maxBp: 3000 }, rationale: 'teste' } });
  assert.equal(bad.body.error.code, 'INVALID_CONTENT');
  assert.equal((await api(app, 'POST', '/v1/knowledge', { as: t.ana, body: { key: 'MAGIC.RULE', scopeType: 'TENANT', content: {}, rationale: 'teste' } })).body.error.code, 'UNKNOWN_KEY');
  assert.equal((await api(app, 'POST', '/v1/knowledge', { as: t.ana, body: { key: 'TIP.ALLOCATION', scopeType: 'GLOBAL', content: { method: 'PROPORTIONAL_TO_CONSUMPTION' }, rationale: 'teste' } })).status, 403);

  const draft = await api(app, 'POST', '/v1/knowledge', {
    as: t.ana,
    body: { key: 'SERVICE_CHARGE.DEFAULT', scopeType: 'TENANT', content: { bp: 1200, maxBp: 3000 }, rationale: 'rede cobra 12%' },
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const k = draft.body.knowledge;
  assert.deepEqual([k.status, k.version, k.critical, k.origin, k.author], ['DRAFT', 1, true, 'HUMAN', 'gerente-ana']);

  const go = (as: object, to: string) => api(app, 'POST', `/v1/knowledge/${k.id}/transition`, { as: as as never, body: { to } });
  assert.equal((await go(t.ana, 'ACTIVE')).body.error.code, 'INVALID_TRANSITION');
  assert.equal((await go(t.system, 'REVIEW')).status, 200);
  assert.match((await go(t.ana, 'APPROVED')).body.error.message, /quatro olhos/);
  assert.equal((await go(t.system, 'APPROVED')).status, 403, 'aprovar exige humano');
  assert.equal((await go(t.ai, 'APPROVED')).status, 403, 'IA não aprova');
  const approved = await go(t.bia, 'APPROVED');
  assert.equal(approved.body.knowledge.approvedBy, 'gerente-bia');

  // Antes de ativar, a regra do segmento (10%) continua valendo.
  const before = await api(app, 'POST', '/v1/bills', { as: t.system, body: { kind: 'RESTAURANT', title: 'Antes', participants: ['A'] } });
  assert.equal(before.body.bill.serviceBp, 1000);
  assert.equal((await go(t.ana, 'ACTIVE')).body.knowledge.status, 'ACTIVE');
  const resolved = await api(app, 'GET', '/v1/knowledge/resolve?key=SERVICE_CHARGE.DEFAULT&segment=RESTAURANT', { as: t.system });
  assert.equal(resolved.body.resolved.scope, 'TENANT');
  assert.deepEqual(resolved.body.resolved.content, { bp: 1200, maxBp: 3000 });
  const afterBill = await api(app, 'POST', '/v1/bills', { as: t.system, body: { kind: 'RESTAURANT', title: 'Depois', participants: ['A'] } });
  assert.equal(afterBill.body.bill.serviceBp, 1200);

  // Nova versão: ativar a v2 aposenta a v1 (histórico preservado).
  const v2 = (await api(app, 'POST', '/v1/knowledge', { as: t.bia, body: { key: 'SERVICE_CHARGE.DEFAULT', scopeType: 'TENANT', content: { bp: 800, maxBp: 3000 }, rationale: 'promoção' } })).body.knowledge;
  assert.equal(v2.version, 2);
  for (const [as, to] of [[t.bia, 'REVIEW'], [t.ana, 'APPROVED'], [t.ana, 'ACTIVE']] as const) {
    assert.equal((await api(app, 'POST', `/v1/knowledge/${v2.id}/transition`, { as, body: { to } })).status, 200, to);
  }
  const list = await api(app, 'GET', '/v1/knowledge?key=SERVICE_CHARGE.DEFAULT', { as: t.system });
  const mine = list.body.knowledge.filter((x: { shared: boolean }) => !x.shared);
  assert.deepEqual(mine.map((x: { version: number; status: string }) => [x.version, x.status]), [[2, 'ACTIVE'], [1, 'SUPERSEDED']]);
  assert.ok(list.body.knowledge.some((x: { shared: boolean; scope: string }) => x.shared && x.scope === 'SEGMENT:RESTAURANT'));
});

test('banco: conhecimento não pula etapas nem muda conteúdo, mesmo por SQL direto', async () => {
  const t = await tenantWithKeys();
  const k = (await api(app, 'POST', '/v1/knowledge', { as: t.ana, body: { key: 'IDEMPOTENCY.TTL', scopeType: 'TENANT', content: { hours: 12 }, rationale: 'teste' } })).body.knowledge;
  const scope = { kind: 'tenant' as const, tenantId: t.tenantId };
  assert.equal(await sqlError(inScope(db, scope, (c) => c.query("UPDATE knowledge SET status = 'ACTIVE' WHERE id = $1", [k.id]))), '23514');
  assert.equal(await sqlError(inScope(db, scope, (c) => c.query(`UPDATE knowledge SET content = '{"hours": 1}' WHERE id = $1`, [k.id]))), '42501');
  assert.equal(await sqlError(inScope(db, scope, (c) => c.query('DELETE FROM knowledge WHERE id = $1', [k.id]))), '42501');
  // Regra não crítica: o próprio autor pode aprovar.
  await api(app, 'POST', `/v1/knowledge/${k.id}/transition`, { as: t.ana, body: { to: 'REVIEW' } });
  assert.equal((await api(app, 'POST', `/v1/knowledge/${k.id}/transition`, { as: t.ana, body: { to: 'APPROVED' } })).status, 200);
});

test('regra com validade vencida deixa de valer e a rotina marca EXPIRED', async () => {
  const t = await tenantWithKeys();
  const k = (await api(app, 'POST', '/v1/knowledge', {
    as: t.ana,
    body: { key: 'IDEMPOTENCY.TTL', scopeType: 'TENANT', content: { hours: 6 }, rationale: 'campanha curta', validFrom: '2026-10-21T00:00:00.000Z', validTo: '2026-10-25T00:00:00.000Z' },
  })).body.knowledge;
  for (const to of ['REVIEW', 'APPROVED', 'ACTIVE']) await api(app, 'POST', `/v1/knowledge/${k.id}/transition`, { as: t.ana, body: { to } });
  assert.deepEqual((await api(app, 'GET', '/v1/knowledge/resolve?key=IDEMPOTENCY.TTL', { as: t.system })).body.resolved.content, { hours: 6 });
  app.clock.set('2026-10-26T00:00:00.000Z');
  try {
    assert.deepEqual((await api(app, 'GET', '/v1/knowledge/resolve?key=IDEMPOTENCY.TTL', { as: t.system })).body.resolved.content, { hours: 24 }, 'volta a valer a regra global');
    await app.runRetention();
    const list = await api(app, 'GET', '/v1/knowledge?key=IDEMPOTENCY.TTL', { as: t.system });
    assert.equal(list.body.knowledge.find((x: { id: string }) => x.id === k.id).status, 'EXPIRED');
  } finally {
    app.clock.set('2026-10-21T12:00:00.000Z');
  }
});

test('administrador da plataforma governa escopos compartilhados; tenant não mexe neles', async () => {
  const t = await tenantWithKeys();
  const k = await api(app, 'POST', '/v1/knowledge', { as: admin('ana'), body: { key: 'PAYMENT.EXPIRY', scopeType: 'SEGMENT', scopeValue: 'TRAVEL', content: { sandboxMinutes: 60, manualMinutes: 20160 }, rationale: 'viagem demora mais' } });
  assert.equal(k.status, 201, JSON.stringify(k.body));
  assert.equal(k.body.knowledge.shared, true);
  const id = k.body.knowledge.id;
  assert.equal((await api(app, 'POST', `/v1/knowledge/${id}/transition`, { as: t.ana, body: { to: 'REVIEW' } })).status, 403);
  assert.equal((await api(app, 'POST', `/v1/knowledge/${id}/transition`, { as: admin('ana'), body: { to: 'REVIEW' } })).status, 200);
  assert.match((await api(app, 'POST', `/v1/knowledge/${id}/transition`, { as: admin('ana'), body: { to: 'APPROVED' } })).body.error.message, /quatro olhos/);
  assert.equal((await api(app, 'POST', `/v1/knowledge/${id}/transition`, { as: admin('bia'), body: { to: 'APPROVED' } })).status, 200);
  assert.equal((await api(app, 'POST', `/v1/knowledge/${id}/transition`, { as: admin('bia'), body: { to: 'ACTIVE' } })).status, 200);
  const resolved = await api(app, 'GET', '/v1/knowledge/resolve?key=PAYMENT.EXPIRY&segment=TRAVEL', { as: t.system });
  assert.deepEqual(resolved.body.resolved.content, { sandboxMinutes: 60, manualMinutes: 20160 });
  assert.equal((await api(app, 'POST', '/v1/knowledge', { as: { admin: 'errado-'.padEnd(43, 'x'), actor: 'x' }, body: {} })).status, 401);
});

test('CBR do tenant Pessoal: o administrador da plataforma lista e resolve (com tenantId), auditado', async () => {
  const PERSONAL = '00000000-0000-4000-8000-000000000001';
  const r = await api(app, 'POST', '/v1/bills', { body: { title: 'Pessoal', organizerName: 'Ana', participants: ['Bia'] } });
  const org = { organizer: r.body.organizerToken };
  await api(app, 'POST', `/v1/bills/${r.body.bill.id}/items`, { as: org, body: { description: 'x', unitPriceCents: 1000 } });
  await api(app, 'POST', `/v1/bills/${r.body.bill.id}/splits`, { as: org, body: { expectedTotalCents: 1000 } });
  const p = await api(app, 'POST', '/v1/payments', { as: { share: r.body.shareToken }, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: r.body.bill.id, participantId: r.body.bill.participants[1].id } });
  await api(app, 'POST', `/v1/bills/${r.body.bill.id}/payments/${p.body.payment.id}/reject`, { as: org });

  assert.equal((await api(app, 'GET', '/v1/cbr/cases', { as: admin('ops') })).body.error.code, 'TENANT_REQUIRED');
  const list = await api(app, 'GET', `/v1/cbr/cases?tenantId=${PERSONAL}&status=OPEN`, { as: admin('ops') });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const mine = list.body.cases.filter((c: { billId: string }) => c.billId === r.body.bill.id);
  assert.equal(mine.length, 1);
  const res = await api(app, 'POST', `/v1/cbr/cases/${mine[0].id}/resolve?tenantId=${PERSONAL}`, { as: admin('ops'), body: { decision: 'NO_ACTION', outcome: 'organizador recusou com razão' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.case.resolvedBy, 'admin:ops');
  const audit = await inScope(db, { kind: 'tenant', tenantId: PERSONAL }, (c) => c.query("SELECT actor_id FROM audit_log WHERE action = 'cbr.resolve' AND allowed"));
  assert.ok(audit.rows.some((a) => a.actor_id === 'admin:ops'));
});

test('CBR: casos → similaridade (Jaccard) → decisão humana → 3 iguais viram proposta LEARNED em DRAFT; nada ativa sozinho', async () => {
  const t = await tenantWithKeys();
  // Três pagamentos manuais recusados pelo caixa geram três casos iguais.
  for (let i = 0; i < 3; i++) {
    const bill = await api(app, 'POST', '/v1/bills', { as: t.system, body: { kind: 'RESTAURANT', title: `Mesa ${i}`, participants: ['A', 'B'] } });
    const id = bill.body.bill.id;
    await api(app, 'POST', `/v1/bills/${id}/items`, { as: t.system, body: { description: 'Prato', unitPriceCents: 5000 } });
    const pv = await api(app, 'POST', `/v1/bills/${id}/splits/preview`, { as: t.system });
    await api(app, 'POST', `/v1/bills/${id}/splits`, { as: t.system, body: { expectedTotalCents: pv.body.preview.totals.totalCents } });
    const p = await api(app, 'POST', '/v1/payments', { as: t.system, headers: { 'idempotency-key': `k-${randomUUID()}` }, body: { billId: id, participantId: bill.body.bill.participants[0].id } });
    assert.equal((await api(app, 'POST', `/v1/bills/${id}/payments/${p.body.payment.id}/reject`, { as: t.ana })).status, 200);
  }
  const cases = (await api(app, 'GET', '/v1/cbr/cases?status=OPEN', { as: t.system })).body.cases;
  assert.equal(cases.length, 3);
  assert.ok(cases.every((c: { kind: string }) => c.kind === 'MANUAL_PAYMENT_REJECTED'));

  const similar = await api(app, 'GET', `/v1/cbr/cases/${cases[0].id}/similar`, { as: t.system });
  assert.equal(similar.body.similar.length, 2);
  assert.ok(similar.body.similar.every((s: { score: number }) => s.score === 1));

  const resolve = (c: { id: string }, as: object) =>
    api(app, 'POST', `/v1/cbr/cases/${c.id}/resolve`, { as: as as never, body: { decision: 'CONTACT_PAYER', outcome: 'cliente pagou no caixa' } });
  assert.equal((await resolve(cases[0], t.system)).status, 403, 'resolver caso exige humano');
  assert.equal((await resolve(cases[0], t.ai)).status, 403);
  assert.equal((await resolve(cases[0], t.ana)).body.proposal, undefined);
  assert.equal((await resolve(cases[1], t.ana)).body.proposal, undefined);
  const third = await resolve(cases[2], t.bia);
  const proposal = third.body.proposal;
  assert.ok(proposal, JSON.stringify(third.body));
  assert.deepEqual([proposal.key, proposal.status, proposal.origin, proposal.author, proposal.critical], ['CBR_PLAYBOOK.MANUAL_PAYMENT_REJECTED', 'DRAFT', 'LEARNED', 'cbr:learning', true]);
  assert.equal(proposal.content.supportingCaseIds.length, 3);
  assert.equal((await resolve(cases[0], t.ana)).body.error.code, 'CASE_RESOLVED');
  assert.deepEqual((await api(app, 'POST', '/v1/cbr/proposals', { as: t.ana })).body.proposals, []);

  // A proposta segue o fluxo humano normal; a IA não aprova.
  await api(app, 'POST', `/v1/knowledge/${proposal.id}/transition`, { as: t.ana, body: { to: 'REVIEW' } });
  assert.equal((await api(app, 'POST', `/v1/knowledge/${proposal.id}/transition`, { as: t.ai, body: { to: 'APPROVED' } })).status, 403);
  const approved = await api(app, 'POST', `/v1/knowledge/${proposal.id}/transition`, { as: t.ana, body: { to: 'APPROVED' } });
  assert.equal(approved.body.knowledge.status, 'APPROVED', 'aprovada, mas não ativa: ativar é outro passo humano');
});
