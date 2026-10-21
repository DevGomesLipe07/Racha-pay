// Skills — capacidades delimitadas e auditáveis, com manifesto (prompt mestre § L).
// Nenhuma grava na conta: devolvem sugestão ou explicação; o humano decide.

import type { Reconciliation } from '../reconciliation/reconcile.ts';

export interface SkillManifest {
  name: string;
  version: string;
  purpose: string;
  inputs: string[];
  outputs: string;
  usesAI: 'never' | 'optional';
  deterministicFallback: string | null;
  requiresConfirmation: boolean;
  writes: 'nothing';
}

export const SKILLS: SkillManifest[] = [
  {
    name: 'ReceiptUnderstandingSkill',
    version: '1.0.0',
    purpose: 'Sugerir itens a partir do cupom (texto ou foto)',
    inputs: ['texto do cupom', 'foto do cupom (JPEG/PNG/WebP, opcional, exige IA ligada)'],
    outputs: 'lista de itens sugeridos + avisos; o organizador revisa e adiciona',
    usesAI: 'optional',
    deterministicFallback: 'parser de texto (sem IA)',
    requiresConfirmation: true,
    writes: 'nothing',
  },
  {
    name: 'ReconciliationExplanationSkill',
    version: '1.0.0',
    purpose: 'Explicar em português por que a conta está no estado atual',
    inputs: ['conciliação determinística da conta'],
    outputs: 'frases em linguagem simples, derivadas só dos números conciliados',
    usesAI: 'never',
    deterministicFallback: null,
    requiresConfirmation: false,
    writes: 'nothing',
  },
];

const brl = (cents: bigint): string => {
  const neg = cents < 0n;
  const v = neg ? -cents : cents;
  const reais = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '−' : ''}R$ ${reais},${(v % 100n).toString().padStart(2, '0')}`;
};

const STATE_TEXT: Record<string, string> = {
  DRAFT: 'A conta ainda está em montagem: a divisão não foi confirmada.',
  OPEN: 'A divisão foi confirmada e ninguém pagou ainda (além da parte de quem organizou, se for o caso).',
  PARTIALLY_PAID: 'Parte do dinheiro já foi confirmada, mas ainda falta gente pagar.',
  SETTLEMENT_PENDING: 'Todo o valor está coberto, mas algum pagamento ainda aguarda confirmação.',
  SETTLED: 'Racha quitado: cada participante tem pagamento confirmado igual ou maior que a própria parte.',
  REOPENED: 'A conta estava quitada e deixou de estar (estorno, contestação ou novos itens).',
  CANCELLED: 'A conta foi cancelada.',
};

/** ReconciliationExplanationSkill — determinística: só reescreve números já conciliados. */
export function explainReconciliation(state: string, r: Reconciliation | null, names: Map<string, string>): string[] {
  const lines = [STATE_TEXT[state] ?? `Estado: ${state}.`];
  if (!r) return lines;
  lines.push(`Total da conta: ${brl(r.totalCents)}. Pago e confirmado: ${brl(r.paidCents)}. Em processamento: ${brl(r.processingCents)}. Falta pagar: ${brl(r.assignedUnpaidCents)}.`);
  for (const p of r.participants) {
    const who = names.get(p.participantId) ?? 'participante';
    if (p.selfSettledCents > 0n && p.paymentsPaidCents === 0n) {
      lines.push(`${who} organizou e já pagou o estabelecimento: a parte dela/dele (${brl(p.dueCents)}) conta como quitada.`);
    } else if (p.paidCents >= p.dueCents) {
      lines.push(`${who} pagou ${brl(p.paidCents)} de ${brl(p.dueCents)}: parte quitada.`);
    } else if (p.processingCents > 0n) {
      lines.push(`${who} tem ${brl(p.processingCents)} aguardando confirmação; falta ${brl(p.unpaidCents)}.`);
    } else {
      lines.push(`${who} deve ${brl(p.unpaidCents)} de ${brl(p.dueCents)}.`);
    }
    if (p.refundDueCents > 0n) lines.push(`${who} pagou ${brl(p.refundDueCents)} a mais — esse excedente não cobre a parte de ninguém e deve ser devolvido.`);
  }
  if (r.unassignedCents > 0n) lines.push(`${brl(r.unassignedCents)} ainda não têm dono: a conta não quita enquanto isso não for dividido.`);
  return lines;
}
