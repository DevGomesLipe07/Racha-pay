// Adapter Anthropic (Claude) do AIProvider — único lugar do código que conhece o SDK (D18).
// Saída estruturada validada por schema (output_config.format + parse); fallback de recusa no servidor
// (fallbacks: "default"); cada item é revalidado aqui antes de virar sugestão.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { MAX_CENTS } from '../split/money.ts';
import { AIUnavailableError, type AIProvider, type ReceiptImage } from './provider.ts';
import type { ReceiptSuggestion } from './receipt-parser.ts';

const ReceiptSchema = z.object({
  items: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().int(),
      unitPriceCents: z.number().int(),
    }),
  ),
  printedTotalCents: z.number().int().nullable(),
  notes: z.array(z.string()),
});

const INSTRUCTION = [
  'Você lê fotos de cupons fiscais e comandas brasileiras para um app de divisão de contas.',
  'Extraia só os itens consumidos: descrição curta, quantidade inteira e preço UNITÁRIO em centavos (inteiro; R$ 12,90 = 1290).',
  'Não inclua totais, subtotais, taxa de serviço, gorjeta, descontos, impostos nem formas de pagamento como itens.',
  'printedTotalCents é o total impresso no cupom, ou null se não aparecer.',
  'Se uma linha estiver ilegível, não invente: descreva o problema em notes.',
].join(' ');

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** Só para testes (servidor falso) ou proxy corporativo. */
  baseURL?: string;
  timeoutMs?: number;
}

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly available = true;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), timeout: opts.timeoutMs ?? 60_000, maxRetries: 2 });
    this.model = opts.model;
  }

  async readReceiptImage(image: ReceiptImage, signal?: AbortSignal): Promise<ReceiptSuggestion> {
    let response;
    try {
      response = await this.client.beta.messages.parse(
        {
          model: this.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium', format: zodOutputFormat(ReceiptSchema) },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
                { type: 'text', text: INSTRUCTION },
              ],
            },
          ],
        },
        signal ? { signal } : {},
      );
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) throw new AIUnavailableError('AI_RATE_LIMITED', 'leitura por foto ocupada; tente de novo em instantes');
      if (error instanceof Anthropic.AuthenticationError) throw new AIUnavailableError('AI_MISCONFIGURED', 'credencial da IA inválida');
      if (error instanceof Anthropic.BadRequestError) throw new AIUnavailableError('AI_BAD_REQUEST', 'a imagem não pôde ser processada');
      if (error instanceof Anthropic.APIError) throw new AIUnavailableError('AI_UNAVAILABLE', 'serviço de IA indisponível');
      throw new AIUnavailableError('AI_UNAVAILABLE', 'serviço de IA indisponível');
    }
    if (response.stop_reason === 'refusal') throw new AIUnavailableError('AI_REFUSED', 'a IA não leu esta imagem; digite os itens');
    if (response.stop_reason === 'max_tokens') throw new AIUnavailableError('AI_TRUNCATED', 'cupom grande demais para a leitura automática');
    const parsed = response.parsed_output;
    if (!parsed) throw new AIUnavailableError('AI_INVALID_OUTPUT', 'a leitura não veio no formato esperado');

    // A IA sugere; o RachaPay revalida cada número antes de mostrar (nunca confia cegamente).
    const warnings: string[] = [...parsed.notes.slice(0, 10).map((n) => String(n).slice(0, 200))];
    const items = parsed.items
      .filter((it) => {
        const ok =
          it.description.trim().length > 0 &&
          Number.isSafeInteger(it.quantity) &&
          it.quantity >= 1 &&
          it.quantity <= 10_000 &&
          Number.isSafeInteger(it.unitPriceCents) &&
          it.unitPriceCents >= 0 &&
          BigInt(it.unitPriceCents) <= MAX_CENTS;
        if (!ok) warnings.push(`item descartado por valor inválido: ${it.description.slice(0, 60)}`);
        return ok;
      })
      .slice(0, 200)
      .map((it) => ({
        description: it.description.trim().slice(0, 120),
        quantity: it.quantity,
        unitPriceCents: it.unitPriceCents,
        lineTotalCents: it.quantity * it.unitPriceCents,
      }));
    const printed = parsed.printedTotalCents !== null && Number.isSafeInteger(parsed.printedTotalCents) && parsed.printedTotalCents >= 0 ? parsed.printedTotalCents : null;
    const sum = items.reduce((s, i) => s + i.lineTotalCents, 0);
    if (printed !== null && printed !== sum) warnings.push(`soma dos itens (${sum}) difere do total impresso (${printed}): confira`);
    return { source: `AI:anthropic:${response.model}`, items, unparsed: [], printedTotalCents: printed, warnings, requiresConfirmation: true };
  }
}
