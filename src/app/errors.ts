// Erro de aplicação com código estável, status HTTP e detalhes seguros para o cliente.
// Envelope: { "error": { "code", "message", "details", "correlationId" } }.

import { MoneyError } from '../modules/split/money.ts';
import { SplitInputError } from '../modules/split/engine.ts';
import { KnowledgeError } from '../modules/expert/library.ts';
import { PaymentEventError } from '../modules/payments/state-machine.ts';

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) => new AppError(400, code, message, details);
export const unauthorized = (message = 'credencial ausente ou inválida') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message: string, details?: Record<string, unknown>) => new AppError(403, 'FORBIDDEN', message, details);
export const notFound = (what = 'recurso') => new AppError(404, 'NOT_FOUND', `${what} não encontrado`);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) => new AppError(422, code, message, details);

/** Converte erros de domínio conhecidos em AppError; o resto vira 500 sem vazar detalhe interno. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof SplitInputError) return new AppError(422, error.code, error.message, error.details);
  if (error instanceof MoneyError) return new AppError(422, error.code, error.message);
  if (error instanceof KnowledgeError) {
    return new AppError(error.code === 'KNOWLEDGE_MISSING' ? 500 : 422, error.code, error.message);
  }
  if (error instanceof PaymentEventError) return new AppError(422, error.code, error.message);
  const pgCode = (error as { code?: unknown })?.code;
  if (pgCode === '40001' || pgCode === '40P01') return new AppError(503, 'RETRY', 'conflito de concorrência; tente de novo');
  if (pgCode === '23505') return new AppError(409, 'CONFLICT', 'registro duplicado');
  return new AppError(500, 'INTERNAL', 'erro interno');
}
