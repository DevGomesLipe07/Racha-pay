// ERP externo → ERPAdapter → Contrato canônico → Core (prompt mestre § P). Nada de "if NexFlow" no domínio:
// cada ERP é um adapter que converte o formato nativo no contrato canônico.

import { z } from 'zod';
import { MAX_CENTS } from '../../split/money.ts';
import { BILL_KINDS } from '../../shared-bills/repo.ts';

const cents = z.number().int().min(0).max(Number(MAX_CENTS));
const ref = z.string().regex(/^[A-Za-z0-9._:/#-]{1,120}$/);

export const canonicalSyncSchema = z
  .object({
    externalReference: ref,
    establishmentExternalId: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/).optional(),
    tableLabel: z.string().trim().min(1).max(40).optional(),
    kind: z.enum(BILL_KINDS).default('RESTAURANT'),
    currency: z.literal('BRL').default('BRL'),
    title: z.string().trim().min(1).max(80).optional(),
    participants: z.array(z.string().trim().min(1).max(60)).max(99).optional(),
    items: z
      .array(
        z
          .object({
            externalRef: ref,
            description: z.string().trim().min(1).max(120),
            unitPriceCents: cents,
            quantity: z.number().int().min(1).max(10_000),
          })
          .strict(),
      )
      .max(500),
    discountCents: cents.default(0),
    serviceBp: z.number().int().min(0).max(10_000).optional(),
    tipCents: cents.default(0),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    for (const it of v.items) {
      if (seen.has(it.externalRef)) ctx.addIssue({ code: 'custom', message: `externalRef repetido: ${it.externalRef}`, path: ['items'] });
      seen.add(it.externalRef);
    }
  });

export type CanonicalSync = z.infer<typeof canonicalSyncSchema>;

export const canonicalAckSchema = z
  .object({
    externalReference: ref,
    event: z.string().regex(/^[a-z]+\.[a-z_]+$/),
    erpDocument: z.string().trim().min(1).max(200),
  })
  .strict();

export type CanonicalAck = z.infer<typeof canonicalAckSchema>;

export interface ERPAdapter {
  readonly provider: string;
  toCanonicalSync(body: unknown): CanonicalSync;
  toCanonicalAck(body: unknown): CanonicalAck;
}

export class ErpAdapterError extends Error {
  readonly issues: { path: string; message: string }[];
  constructor(issues: { path: string; message: string }[]) {
    super('payload do ERP inválido');
    this.name = 'ErpAdapterError';
    this.issues = issues;
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ErpAdapterError(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

/** O próprio contrato canônico (qualquer ERP, NexFlow incluído, pode integrar enviando-o). */
export const genericAdapter: ERPAdapter = {
  provider: 'generic',
  toCanonicalSync: (body) => parse(canonicalSyncSchema, body),
  toCanonicalAck: (body) => parse(canonicalAckSchema, body),
};

/** Adapters nativos bloqueados por dependência externa — respondem 501 com o motivo, sem fingir integração. */
export const BLOCKED_ADAPTERS: Record<string, string> = {
  nexflow:
    'adapter nativo do NexFlow BLOQUEADO: falta decidir o que, no NexFlow (ERP de serviços, sem mesa/comanda), vira uma conta. Use /v1/integrations/erp/generic com o contrato canônico.',
};

export const ADAPTERS: Record<string, ERPAdapter> = { generic: genericAdapter };
