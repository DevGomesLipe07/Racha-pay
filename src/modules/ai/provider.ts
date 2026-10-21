// AIProvider — substituível; nenhum SDK entra no domínio (Constituição § A IA apoia; prompt mestre § L).
// O padrão é o NullAIProvider: o sistema inteiro funciona sem LLM. A IA só SUGERE (requiresConfirmation);
// nada do que ela devolve é gravado na conta, e falha dela nunca derruba o núcleo financeiro.

import type { ReceiptSuggestion } from './receipt-parser.ts';

export interface ReceiptImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Base64 sem prefixo data:. */
  data: string;
}

export interface AIProvider {
  readonly name: string;
  readonly available: boolean;
  readReceiptImage(image: ReceiptImage, signal?: AbortSignal): Promise<ReceiptSuggestion>;
}

export class AIUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AIUnavailableError';
    this.code = code;
  }
}

export class NullAIProvider implements AIProvider {
  readonly name = 'none';
  readonly available = false;
  async readReceiptImage(): Promise<ReceiptSuggestion> {
    throw new AIUnavailableError('AI_DISABLED', 'leitura de foto desligada neste ambiente; envie o texto do cupom');
  }
}
