import { z } from 'zod';
import type { HttpRequest } from '../infra/http/router.ts';
import { MAX_CENTS } from '../modules/split/money.ts';
import { badRequest, unprocessable } from './errors.ts';

/** Centavos na fronteira (D14): inteiro JSON 0..R$ 1 bilhão → BigInt. */
export const cents = z
  .number()
  .int('centavos devem ser inteiros')
  .min(0)
  .max(Number(MAX_CENTS))
  .transform((v) => BigInt(v));

export const uuid = z.uuid();

export function parseBody<S extends z.ZodType>(schema: S, req: HttpRequest): z.infer<S> {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw unprocessable('VALIDATION_ERROR', 'dados inválidos', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

export function param(req: HttpRequest, name: string): string {
  const v = req.params[name];
  if (!v || !uuid.safeParse(v).success) throw badRequest('INVALID_ID', `${name} inválido`);
  return v;
}
