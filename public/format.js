// Formatação para exibição. Nenhuma conta de dinheiro acontece no navegador: a entrada do usuário vira
// centavos inteiros por manipulação de texto, e todo total/parte/saldo vem pronto da API.

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export const brl = (cents) => BRL.format(cents / 100);

/** "89,90" | "89.90" | "1.234,56" | "R$ 12" → centavos (inteiro) ou null. */
export function parseMoney(text) {
  const s = String(text ?? '').replace(/R\$|\s/g, '');
  let intPart;
  let fracPart = '';
  let m;
  if ((m = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(s))) {
    intPart = m[1].replace(/\./g, '');
    fracPart = m[2] ?? '';
  } else if ((m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(s))) {
    intPart = m[1];
    fracPart = m[2] ?? '';
  } else {
    return null;
  }
  return Number(intPart) * 100 + Number(fracPart.padEnd(2, '0') || '0');
}

/** "10" | "12,5" | "33,33" → pontos-base (1 bp = 0,01%) ou null. */
export function parsePercentBp(text) {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(String(text ?? '').replace(/%|\s/g, ''));
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bp <= 10000 ? bp : null;
}

export const pct = (bp) => `${(bp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

export const STATE_LABEL = {
  DRAFT: 'Em montagem',
  OPEN: 'Aberta para pagamento',
  PARTIALLY_PAID: 'Parcialmente paga',
  SETTLEMENT_PENDING: 'Aguardando confirmação',
  SETTLED: 'Quitada',
  REOPENED: 'Reaberta',
  CANCELLED: 'Cancelada',
};

export const PAYMENT_LABEL = {
  CREATED: 'criando',
  PENDING: 'aguardando confirmação',
  AUTHORIZED: 'autorizado (ainda não pago)',
  CONFIRMED: 'confirmado',
  FAILED: 'falhou',
  EXPIRED: 'expirou',
  REJECTED: 'recusado',
  REFUNDED: 'estornado',
  CHARGEDBACK: 'contestado',
};

export const KIND_LABEL = {
  RESTAURANT: 'Restaurante / bar',
  TRAVEL: 'Viagem',
  TRANSPORT: 'Transporte',
  MARKET: 'Mercado',
  EVENT: 'Evento',
  GIFT: 'Presente',
  FUEL: 'Combustível',
  ACCOMMODATION: 'Hospedagem',
  OTHER: 'Outro',
};

export const MODE_LABEL = {
  EQUAL: 'Igual para todos',
  BY_ITEM: 'Cada um o que consumiu',
  PERCENT: 'Por percentual',
  MANUAL: 'Valores definidos',
};
