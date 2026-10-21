import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, decide, type PolicyAction } from '../../src/modules/policies/policy-engine.ts';

const allActions = Object.keys(ACTIONS) as PolicyAction[];

test('IA com escopo * é negada em TODAS as ações financeiras críticas', () => {
  const critical = allActions.filter((a) => ACTIONS[a].financialCritical);
  assert.ok(critical.length >= 10);
  for (const action of critical) {
    const d = decide(action, { type: 'AI', id: 'agent', scopes: ['*'] });
    assert.equal(d.allowed, false, action);
    assert.equal(d.audit, true, action);
  }
});

test('IA pode só ações não críticas (ex.: sugestão)', () => {
  assert.equal(decide('ai.suggest', { type: 'AI', id: 'agent', scopes: ['*'] }).allowed, true);
  assert.equal(decide('bill.read', { type: 'AI', id: 'agent', scopes: ['*'] }).allowed, true);
});

test('confirmação manual, aprovação de conhecimento e resolução de caso exigem humano', () => {
  for (const action of ['payment.confirm_manual', 'knowledge.approve', 'knowledge.activate', 'cbr.resolve'] as const) {
    assert.equal(decide(action, { type: 'SYSTEM', id: 'erp', scopes: ['*'] }).allowed, false, action);
    assert.equal(decide(action, { type: 'HUMAN', id: 'ana', scopes: ['*'] }).allowed, true, action);
  }
});

test('escopo ausente é negado e auditado', () => {
  const d = decide('erp.sync', { type: 'SYSTEM', id: 'erp', scopes: ['bills:read'] });
  assert.equal(d.allowed, false);
  assert.equal(d.audit, true);
  assert.equal(decide('erp.sync', { type: 'SYSTEM', id: 'erp', scopes: ['erp:sync'] }).allowed, true);
});

test('ações críticas permitidas também são auditadas', () => {
  const d = decide('split.confirm', { type: 'HUMAN', id: 'org', scopes: ['*'] });
  assert.equal(d.allowed, true);
  assert.equal(d.audit, true);
  assert.equal(d.policyVersion, 'POLICY_V1');
});

test('ação desconhecida é negada', () => {
  assert.equal(decide('money.print' as PolicyAction, { type: 'HUMAN', id: 'x', scopes: ['*'] }).allowed, false);
});
