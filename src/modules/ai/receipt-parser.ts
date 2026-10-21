// Leitura de cupom em TEXTO — determinística, sem IA (a IA é opcional e só para foto).
// Reconhece linhas como:
//   "PICANHA 89,90"            → 1 × 89,90
//   "2 x CERVEJA 12,00"        → 2 × 6,00 (12,00 é o total da linha)
//   "CERVEJA 2 UN 6,00 12,00"  → 2 × 6,00
//   "2x Refri 6,00"            → 2 × 3,00
// Ignora totais, subtotais, taxas, troco e linhas sem preço. Tudo é SUGESTÃO para o humano confirmar.

export interface ReceiptItemSuggestion {
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface ReceiptSuggestion {
  source: string;
  items: ReceiptItemSuggestion[];
  /** Linhas que pareciam item mas não foram entendidas (o humano decide). */
  unparsed: string[];
  /** Total impresso no cupom, se houver — só para conferência. */
  printedTotalCents: number | null;
  warnings: string[];
  requiresConfirmation: true;
}

const MONEY = /(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})\b/g;
const SKIP = /\b(sub-?total|total|troco|desconto|servi[cç]o|taxa|gorjeta|cart[aã]o|dinheiro|pix|cpf|cnpj|cupom|nfc-?e|obrigado|data|hora)\b/i;
const TOTAL = /\btotal\b/i;

function toCents(match: RegExpMatchArray): number {
  return Number((match[1] as string).replace(/\./g, '')) * 100 + Number(match[2]);
}

function clean(description: string): string {
  return description
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–•*.]+|[\s\-–•*.:]+$/g, '')
    .trim();
}

export function parseReceiptText(text: string): ReceiptSuggestion {
  const items: ReceiptItemSuggestion[] = [];
  const unparsed: string[] = [];
  const warnings: string[] = [];
  let printedTotalCents: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const prices = [...line.matchAll(MONEY)];
    if (prices.length === 0) continue;
    if (SKIP.test(line)) {
      if (TOTAL.test(line) && !/sub-?total/i.test(line)) printedTotalCents = toCents(prices.at(-1) as RegExpMatchArray);
      continue;
    }
    const first = prices[0] as RegExpMatchArray;
    let head = line.slice(0, first.index).trim();
    const lineTotal = toCents(prices.at(-1) as RegExpMatchArray);
    let quantity = 1;

    // "2 x CERVEJA" / "2x Refri" no início
    const lead = /^(\d{1,3})\s*[xX×]\s*(.+)$/.exec(head);
    // "CERVEJA 2 UN" / "CERVEJA 2 x" no fim
    const trail = /^(.+?)\s+(\d{1,3})\s*(?:un|und|unid|x|×)?\.?$/i.exec(head);
    if (lead) {
      quantity = Number(lead[1]);
      head = lead[2] as string;
    } else if (trail && prices.length >= 2) {
      quantity = Number(trail[2]);
      head = trail[1] as string;
    }
    const description = clean(head).slice(0, 120);
    if (!description || quantity < 1) {
      unparsed.push(line);
      continue;
    }
    if (lineTotal % quantity !== 0) {
      // Total da linha não divide exato: mantém 1 × total para não inventar centavo.
      warnings.push(`"${description}": total ${lineTotal} não divide por ${quantity}; sugerido como 1 item`);
      items.push({ description, quantity: 1, unitPriceCents: lineTotal, lineTotalCents: lineTotal });
      continue;
    }
    items.push({ description, quantity, unitPriceCents: lineTotal / quantity, lineTotalCents: lineTotal });
  }

  const sum = items.reduce((s, i) => s + i.lineTotalCents, 0);
  if (printedTotalCents !== null && printedTotalCents !== sum) {
    warnings.push(`soma dos itens (${sum}) difere do total impresso (${printedTotalCents}): confira`);
  }
  return { source: 'TEXT_PARSER', items, unparsed, printedTotalCents, warnings, requiresConfirmation: true };
}
