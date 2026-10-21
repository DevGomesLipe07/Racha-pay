// Policy Engine — puro (Constituição § A IA apoia; prompt mestre § F).
// LLM/agente nunca determina sozinho pagamento recebido, saldo, quitação, estorno, chargeback ou liquidação.
// Decisões negadas e decisões sobre ações críticas devem ser auditadas pelo chamador (`audit: true`).

import type { ActorType } from '../ledger/chain.ts';

export const POLICY_VERSION = 'POLICY_V1';

interface ActionSpec {
  /** Escopo exigido de chaves de API (rpk_). Tokens de capacidade têm regras próprias. */
  scope: string;
  financialCritical: boolean;
  /** Exige ator humano (não SYSTEM, não AI). */
  humanOnly: boolean;
}

export const ACTIONS = {
  'bill.create': { scope: 'bills:write', financialCritical: false, humanOnly: false },
  'bill.read': { scope: 'bills:read', financialCritical: false, humanOnly: false },
  'bill.edit': { scope: 'bills:write', financialCritical: false, humanOnly: false },
  'bill.cancel': { scope: 'bills:write', financialCritical: true, humanOnly: false },
  'bill.anonymize': { scope: 'bills:write', financialCritical: false, humanOnly: true },
  'split.preview': { scope: 'bills:read', financialCritical: false, humanOnly: false },
  'split.confirm': { scope: 'bills:write', financialCritical: true, humanOnly: false },
  'split.unlock': { scope: 'bills:write', financialCritical: true, humanOnly: false },
  'split.complement': { scope: 'bills:write', financialCritical: true, humanOnly: false },
  'payment.create': { scope: 'payments:create', financialCritical: true, humanOnly: false },
  'payment.confirm_manual': { scope: 'payments:write', financialCritical: true, humanOnly: true },
  'payment.reject_manual': { scope: 'payments:write', financialCritical: true, humanOnly: true },
  'payment.apply_provider_event': { scope: 'payments:provider', financialCritical: true, humanOnly: false },
  'payment.expire': { scope: 'payments:provider', financialCritical: true, humanOnly: false },
  'refund.request': { scope: 'payments:write', financialCritical: true, humanOnly: false },
  'refund.record_manual': { scope: 'payments:write', financialCritical: true, humanOnly: true },
  'knowledge.read': { scope: 'knowledge:read', financialCritical: false, humanOnly: false },
  'knowledge.propose': { scope: 'knowledge:write', financialCritical: false, humanOnly: false },
  'knowledge.approve': { scope: 'knowledge:approve', financialCritical: true, humanOnly: true },
  'knowledge.activate': { scope: 'knowledge:approve', financialCritical: true, humanOnly: true },
  'cbr.read': { scope: 'cbr:read', financialCritical: false, humanOnly: false },
  'cbr.resolve': { scope: 'cbr:write', financialCritical: true, humanOnly: true },
  'establishment.manage': { scope: 'establishments:write', financialCritical: false, humanOnly: false },
  'erp.sync': { scope: 'erp:sync', financialCritical: false, humanOnly: false },
  'erp.ack': { scope: 'erp:sync', financialCritical: false, humanOnly: false },
  'webhooks.manage': { scope: 'webhooks:write', financialCritical: false, humanOnly: false },
  'metrics.read': { scope: 'metrics:read', financialCritical: false, humanOnly: false },
  'ai.suggest': { scope: 'ai:use', financialCritical: false, humanOnly: false },
} as const satisfies Record<string, ActionSpec>;

export type PolicyAction = keyof typeof ACTIONS;

export interface PolicyActor {
  type: ActorType;
  id: string;
  /** Escopos da credencial. '*' = todos (ainda sujeito às regras de IA e de ator humano). */
  scopes: readonly string[];
}

export interface PolicyDecision {
  allowed: boolean;
  action: PolicyAction;
  reason: string;
  policyVersion: string;
  financialCritical: boolean;
  /** Negadas e críticas vão para o audit_log. */
  audit: boolean;
}

export function decide(action: PolicyAction, actor: PolicyActor): PolicyDecision {
  const spec: ActionSpec | undefined = ACTIONS[action];
  const base = { action, policyVersion: POLICY_VERSION, financialCritical: spec?.financialCritical ?? true };
  if (!spec) return { ...base, allowed: false, reason: 'ação desconhecida', audit: true };

  if (actor.type === 'AI' && spec.financialCritical) {
    return { ...base, allowed: false, reason: 'IA não executa ação financeira crítica', audit: true };
  }
  if (spec.humanOnly && actor.type !== 'HUMAN') {
    return { ...base, allowed: false, reason: 'ação exige ator humano', audit: true };
  }
  if (!actor.scopes.includes('*') && !actor.scopes.includes(spec.scope)) {
    return { ...base, allowed: false, reason: `escopo ausente: ${spec.scope}`, audit: true };
  }
  return { ...base, allowed: true, reason: 'permitido', audit: spec.financialCritical };
}

export function isFinancialCritical(action: PolicyAction): boolean {
  return ACTIONS[action].financialCritical;
}
