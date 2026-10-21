// Expert Library / CEKE — resolução de conhecimento ativo e vigente, mais específico primeiro.
// Regras parametrizáveis vivem aqui, não em constantes espalhadas (prompt mestre § J).

import { z } from 'zod';
import type { PoolClient } from '../../infra/db/pool.ts';

export const SCOPE_ORDER = ['GLOBAL', 'COUNTRY', 'SEGMENT', 'ERP', 'PSP', 'TENANT', 'ESTABLISHMENT'] as const;
export type KnowledgeScope = (typeof SCOPE_ORDER)[number];

const bp = z.number().int().min(0).max(10_000);

/** Schema do conteúdo de cada chave operacional — validado antes de aprovar e ao resolver. */
export const CONTENT_SCHEMAS = {
  'SERVICE_CHARGE.DEFAULT': z
    .object({ bp, maxBp: bp })
    .strict()
    .refine((c) => c.bp <= c.maxBp, 'bp não pode passar de maxBp'),
  'DISCOUNT.ALLOCATION': z.object({ method: z.literal('PROPORTIONAL_TO_CONSUMPTION') }).strict(),
  'TIP.ALLOCATION': z.object({ method: z.literal('PROPORTIONAL_TO_CONSUMPTION') }).strict(),
  'ROUNDING.ALLOCATION': z
    .object({ method: z.literal('LARGEST_REMAINDER'), tieBreak: z.literal('PARTICIPANT_POSITION') })
    .strict(),
  'PAYMENT.EXPIRY': z
    .object({ sandboxMinutes: z.number().int().min(1).max(1440), manualMinutes: z.number().int().min(60).max(43_200) })
    .strict(),
  'IDEMPOTENCY.TTL': z.object({ hours: z.number().int().min(1).max(168) }).strict(),
  'RATE_LIMIT.ANON_BILL_CREATE': z
    .object({ perMinute: z.number().int().min(1).max(1000), perHour: z.number().int().min(1).max(10_000) })
    .strict(),
  'WEBHOOK.RETRY': z
    .object({
      maxAttempts: z.number().int().min(1).max(30),
      baseSeconds: z.number().int().min(1).max(3600),
      maxIntervalSeconds: z.number().int().min(1).max(86_400),
    })
    .strict(),
} as const;

export type KnowledgeKey = keyof typeof CONTENT_SCHEMAS;

/** Proposta aprendida pelo CBR: como tratar um tipo de exceção (não é usada por nenhuma regra automática). */
export const PLAYBOOK_SCHEMA = z
  .object({
    caseKind: z.string().regex(/^[A-Z_]+$/),
    decision: z.string().min(1).max(120),
    supportingCaseIds: z.array(z.uuid()).min(3).max(100),
    supportingCases: z.number().int().min(3),
  })
  .strict();

/** Chaves cujo erro mexe em dinheiro: exigem quatro olhos (aprovador ≠ autor). */
export const CRITICAL_KEYS = new Set<string>(['SERVICE_CHARGE.DEFAULT', 'DISCOUNT.ALLOCATION', 'TIP.ALLOCATION', 'ROUNDING.ALLOCATION', 'PAYMENT.EXPIRY']);

export function isCriticalKey(key: string): boolean {
  return CRITICAL_KEYS.has(key) || key.startsWith('CBR_PLAYBOOK.');
}

/** Schema de qualquer chave governável; desconhecida = recusada (conteúdo sempre validado antes de aprovar). */
export function schemaFor(key: string): z.ZodType | undefined {
  if (key in CONTENT_SCHEMAS) return CONTENT_SCHEMAS[key as KnowledgeKey];
  if (/^CBR_PLAYBOOK\.[A-Z_]+$/.test(key)) return PLAYBOOK_SCHEMA;
  return undefined;
}
export type KnowledgeContent<K extends KnowledgeKey> = z.infer<(typeof CONTENT_SCHEMAS)[K]>;

export interface ResolutionContext {
  tenantId: string;
  country?: string;
  segment?: string;
  erp?: string;
  psp?: string;
  establishmentId?: string;
}

export interface ResolvedKnowledge<K extends KnowledgeKey> {
  id: string;
  key: K;
  scopeType: KnowledgeScope;
  scopeValue: string;
  version: number;
  content: KnowledgeContent<K>;
}

export class KnowledgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
  }
}

export function validateContent<K extends KnowledgeKey>(key: K, content: unknown): KnowledgeContent<K> {
  const schema = CONTENT_SCHEMAS[key];
  if (!schema) throw new KnowledgeError('UNKNOWN_KEY', `chave de conhecimento desconhecida: ${key}`);
  const parsed = schema.safeParse(content);
  if (!parsed.success) {
    throw new KnowledgeError('INVALID_CONTENT', `conteúdo inválido para ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data as KnowledgeContent<K>;
}

export async function resolveKnowledge<K extends KnowledgeKey>(
  client: PoolClient,
  key: K,
  ctx: ResolutionContext,
  at: Date,
): Promise<ResolvedKnowledge<K>> {
  const { rows } = await client.query<{ id: string; scope_type: KnowledgeScope; scope_value: string; version: number; content: unknown }>(
    `SELECT id, scope_type, scope_value, version, content
       FROM knowledge
      WHERE key = $1 AND status = 'ACTIVE' AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)
        AND (   scope_type = 'GLOBAL'
             OR (scope_type = 'COUNTRY' AND scope_value = $3)
             OR (scope_type = 'SEGMENT' AND scope_value = $4)
             OR (scope_type = 'ERP' AND scope_value = $5)
             OR (scope_type = 'PSP' AND scope_value = $6)
             OR (scope_type = 'TENANT' AND tenant_id = $7)
             OR (scope_type = 'ESTABLISHMENT' AND tenant_id = $7 AND scope_value = $8))
      ORDER BY array_position($9::text[], scope_type) DESC, version DESC
      LIMIT 1`,
    [
      key,
      at,
      ctx.country ?? 'BR',
      ctx.segment ?? '',
      ctx.erp ?? '',
      ctx.psp ?? '',
      ctx.tenantId,
      ctx.establishmentId ?? '',
      SCOPE_ORDER as unknown as string[],
    ],
  );
  const row = rows[0];
  if (!row) throw new KnowledgeError('KNOWLEDGE_MISSING', `nenhum conhecimento ativo para ${key}`);
  return {
    id: row.id,
    key,
    scopeType: row.scope_type,
    scopeValue: row.scope_value,
    version: row.version,
    content: validateContent(key, row.content),
  };
}

/** Proveniência compacta para gravar junto da decisão (split_versions.rules e ledger). */
export function provenance(k: ResolvedKnowledge<KnowledgeKey>): { key: string; id: string; version: number; scope: string } {
  return { key: k.key, id: k.id, version: k.version, scope: k.scopeValue ? `${k.scopeType}:${k.scopeValue}` : k.scopeType };
}
