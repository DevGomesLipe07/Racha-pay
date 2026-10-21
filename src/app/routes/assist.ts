// Assistência (IA como apoio) e métricas North Star.
//   POST /v1/bills/{id}/receipt     sugestão de itens: texto (parser) ou foto (IA opcional) — nada é gravado
//   GET  /v1/bills/{id}/explanation explicação determinística da conciliação
//   GET  /v1/skills                 manifesto das skills
//   GET  /v1/metrics                North Star do tenant (chave de API) ou de um tenant (admin)

import { z } from 'zod';
import { withScope } from '../../infra/db/tx.ts';
import type { Router } from '../../infra/http/router.ts';
import { AIUnavailableError, type ReceiptImage } from '../../modules/ai/provider.ts';
import { parseReceiptText } from '../../modules/ai/receipt-parser.ts';
import { explainReconciliation, SKILLS } from '../../modules/ai/skills.ts';
import { monthMetrics, saoPauloMonth } from '../../modules/analytics/metrics.ts';
import { loadReconciliation } from '../../modules/reconciliation/service.ts';
import { loadBill } from '../../modules/shared-bills/repo.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, badRequest, forbidden, notFound, unprocessable } from '../errors.ts';
import { preAuthorize } from '../guard.ts';
import { parseBody, uuid } from '../http-helpers.ts';
import { routeKit } from './common.ts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const receiptSchema = z.union([
  z.object({ text: z.string().min(1).max(20_000) }).strict(),
  z
    .object({
      image: z.object({ mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']), data: z.string().min(16).max(7_000_000) }).strict(),
    })
    .strict(),
]);

/** Confere a assinatura do arquivo: o tipo declarado tem de bater com os bytes. */
function checkImage(image: ReceiptImage): void {
  if (!/^[A-Za-z0-9+/]+=*$/.test(image.data)) throw unprocessable('INVALID_IMAGE', 'imagem deve vir em base64 puro (sem data:)');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new AppError(413, 'IMAGE_TOO_LARGE', 'imagem acima de 5 MB');
  const magic =
    (image.mediaType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (image.mediaType === 'image/png' && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) ||
    (image.mediaType === 'image/webp' && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP');
  if (!magic) throw unprocessable('INVALID_IMAGE', 'o conteúdo não corresponde ao tipo de imagem informado');
}

export function registerAssistRoutes(router: Router, deps: AppDeps): void {
  const { pool, clock, ai } = deps;
  const { onBill, principalOf } = routeKit(deps);

  router.post(
    '/v1/bills/:id/receipt',
    onBill(
      'ai.suggest',
      async (client, _ctx, req, billId) => {
        const input = parseBody(receiptSchema, req);
        const bill = await loadBill(client, billId);
        if (!bill) throw notFound('conta');
        if ('text' in input) return { suggestion: parseReceiptText(input.text) };
        checkImage(input.image);
        try {
          return { suggestion: await ai.readReceiptImage(input.image) };
        } catch (e) {
          // Falha da IA nunca vira erro do núcleo: resposta clara e o caminho manual continua aberto.
          if (e instanceof AIUnavailableError) throw new AppError(e.code === 'AI_DISABLED' ? 501 : 503, e.code, e.message);
          throw new AppError(503, 'AI_UNAVAILABLE', 'leitura por foto indisponível; digite os itens');
        }
      },
      { respond: 'result' },
    ),
    { maxBodyBytes: 7 * 1024 * 1024 },
  );

  router.get(
    '/v1/bills/:id/explanation',
    onBill(
      'bill.read',
      async (client, _ctx, _req, billId) => {
        const bill = await loadBill(client, billId);
        if (!bill) throw notFound('conta');
        const { reconciliation, confirmed } = await loadReconciliation(client, bill);
        const { rows } = await client.query<{ id: string; name: string }>('SELECT id, name FROM participants WHERE bill_id = $1', [billId]);
        return {
          skill: 'ReconciliationExplanationSkill',
          state: bill.state,
          explanation: explainReconciliation(bill.state, confirmed ? reconciliation : null, new Map(rows.map((r) => [r.id, r.name]))),
          usesAI: false,
        };
      },
      { respond: 'result' },
    ),
  );

  router.get('/v1/skills', async () => ({
    status: 200,
    body: { skills: SKILLS.map((s) => ({ ...s, available: s.usesAI === 'never' || s.deterministicFallback !== null || ai.available })), aiProvider: ai.name },
  }));

  router.get('/v1/metrics', async (req) => {
    const principal = await principalOf(req);
    const month = req.query.get('month') ?? saoPauloMonth(clock.now());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('INVALID_MONTH', 'month deve ser YYYY-MM');
    let tenantId: string;
    if (principal.kind === 'apiKey') tenantId = principal.tenantId;
    else if (principal.kind === 'admin') {
      const t = req.query.get('tenantId');
      if (!t || !uuid.safeParse(t).success) throw badRequest('TENANT_REQUIRED', 'administrador: informe tenantId');
      tenantId = t;
    } else throw forbidden('métricas exigem chave de API do tenant ou credencial de administrador');
    await preAuthorize(pool, principal, 'metrics.read', { tenantId, billId: null }, req.correlationId);
    const metrics = await withScope(pool, { kind: 'tenant', tenantId }, (c) => monthMetrics(c, month));
    return { status: 200, body: { metrics } };
  });
}
