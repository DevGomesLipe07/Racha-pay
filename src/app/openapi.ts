// Documento OpenAPI 3.1 gerado a partir dos MESMOS schemas Zod que validam as requisições — não há
// segunda fonte para desatualizar. Um teste garante que toda rota registrada está descrita aqui.

import { z } from 'zod';
import { canonicalAckSchema, canonicalSyncSchema } from '../modules/integrations/erp/adapter.ts';
import { receiptSchema } from './routes/assist.ts';
import { billCreateSchema, billPatchSchema, itemSchema, participantPatchSchema } from './routes/bills.ts';
import { establishmentSchema } from './routes/erp.ts';
import { knowledgeProposeSchema } from './routes/intelligence.ts';
import { paymentCreateSchema, refundSchema, simulateSchema } from './routes/payments.ts';
import { webhookEndpointSchema } from './routes/webhooks.ts';

type Auth = 'none' | 'organizer' | 'guest' | 'apiKey' | 'admin';

interface Op {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  tag: string;
  summary: string;
  auth: Auth[];
  body?: z.ZodType;
  idempotent?: boolean;
  success?: number;
}

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });

const anyOrganizerOrKey: Auth[] = ['organizer', 'apiKey'];
const readers: Auth[] = ['organizer', 'guest', 'apiKey'];

export const OPERATIONS: Op[] = [
  { method: 'get', path: '/health', tag: 'Operação', summary: 'Processo no ar', auth: ['none'] },
  { method: 'get', path: '/ready', tag: 'Operação', summary: 'Pronto (banco respondendo)', auth: ['none'] },
  { method: 'get', path: '/metrics', tag: 'Operação', summary: 'Métricas Prometheus', auth: ['admin'] },
  { method: 'get', path: '/openapi.json', tag: 'Operação', summary: 'Este documento', auth: ['none'] },
  { method: 'get', path: '/v1/config', tag: 'Operação', summary: 'Configuração pública (sandbox, IA)', auth: ['none'] },

  { method: 'post', path: '/v1/bills', tag: 'Contas', summary: 'Criar conta (anônimo = pessoal; chave = estabelecimento)', auth: ['none', 'apiKey'], body: billCreateSchema, success: 201 },
  { method: 'get', path: '/v1/bills', tag: 'Contas', summary: 'Listar contas do tenant (painel Business)', auth: ['apiKey'] },
  { method: 'get', path: '/v1/bills/{id}', tag: 'Contas', summary: 'Ver conta, partes, saldos e conciliação', auth: readers },
  { method: 'patch', path: '/v1/bills/{id}', tag: 'Contas', summary: 'Editar título, modo, desconto, serviço, gorjeta (rascunho)', auth: anyOrganizerOrKey, body: billPatchSchema },
  { method: 'post', path: '/v1/bills/{id}/cancel', tag: 'Contas', summary: 'Cancelar (sem pagamentos ativos ou recebidos)', auth: anyOrganizerOrKey },
  { method: 'post', path: '/v1/bills/{id}/share-links', tag: 'Contas', summary: 'Emitir novo link de convidado (D20)', auth: anyOrganizerOrKey, success: 201 },
  { method: 'put', path: '/v1/bills/{id}/pix', tag: 'Contas', summary: 'Chave Pix do organizador (D23); null remove', auth: ['organizer'], body: z.object({ pixKey: z.string().nullable(), pixCity: z.string().optional() }) },
  { method: 'get', path: '/v1/bills/{id}/participants/{pid}/pix', tag: 'Contas', summary: 'Pix copia e cola da parte (valor calculado no servidor)', auth: readers },
  { method: 'post', path: '/v1/bills/{id}/anonymize', tag: 'Contas', summary: 'LGPD: anonimizar agora (D21)', auth: ['organizer', 'apiKey'] },
  { method: 'post', path: '/v1/bills/{id}/participants', tag: 'Contas', summary: 'Adicionar participante', auth: anyOrganizerOrKey, body: z.object({ name: z.string().min(1).max(60) }), success: 201 },
  { method: 'patch', path: '/v1/bills/{id}/participants/{pid}', tag: 'Contas', summary: 'Editar participante (nome, percentual, valor manual)', auth: anyOrganizerOrKey, body: participantPatchSchema },
  { method: 'delete', path: '/v1/bills/{id}/participants/{pid}', tag: 'Contas', summary: 'Remover participante (rascunho, sem pagamentos — D8)', auth: anyOrganizerOrKey },
  { method: 'post', path: '/v1/bills/{id}/items', tag: 'Contas', summary: 'Adicionar item (depois da divisão vira complemento — D2)', auth: anyOrganizerOrKey, body: itemSchema, success: 201 },
  { method: 'put', path: '/v1/bills/{id}/items/{itemId}/assignees', tag: 'Contas', summary: 'Quem consumiu o item (pesos)', auth: anyOrganizerOrKey, body: z.object({ assignees: z.array(z.object({ participantId: z.uuid(), weight: z.number().int().optional() })) }) },
  { method: 'delete', path: '/v1/bills/{id}/items/{itemId}', tag: 'Contas', summary: 'Remover item ainda não confirmado', auth: anyOrganizerOrKey },
  { method: 'post', path: '/v1/bills/{id}/splits/preview', tag: 'Divisão', summary: 'Prévia da divisão (ou do complemento)', auth: readers },
  { method: 'post', path: '/v1/bills/{id}/splits', tag: 'Divisão', summary: 'Confirmar divisão ou complemento (recusa prévia desatualizada)', auth: anyOrganizerOrKey, body: z.object({ expectedTotalCents: z.number().int() }), success: 201 },
  { method: 'post', path: '/v1/bills/{id}/splits/unlock', tag: 'Divisão', summary: 'Destravar (sem pagamentos)', auth: anyOrganizerOrKey },
  { method: 'get', path: '/v1/bills/{id}/reconciliation', tag: 'Divisão', summary: 'Conciliação: TOTAL = PAGO + EM PROCESSAMENTO + NÃO PAGO + NÃO ATRIBUÍDO − EXCEDENTE', auth: readers },
  { method: 'get', path: '/v1/bills/{id}/ledger', tag: 'Divisão', summary: 'Ledger encadeado, verificação e reconstrução', auth: readers },
  { method: 'get', path: '/v1/bills/{id}/explanation', tag: 'Assistência', summary: 'Explicação em português da conciliação (sem IA)', auth: readers },
  { method: 'post', path: '/v1/bills/{id}/receipt', tag: 'Assistência', summary: 'Sugerir itens a partir do cupom (texto ou foto) — nada é gravado', auth: readers, body: receiptSchema },

  { method: 'post', path: '/v1/payments', tag: 'Pagamentos', summary: 'Criar pagamento (manual ou sandbox)', auth: readers, body: paymentCreateSchema, idempotent: true, success: 201 },
  { method: 'post', path: '/v1/bills/{id}/payments/{pid}/confirm', tag: 'Pagamentos', summary: 'Confirmar pagamento manual (ator humano)', auth: ['organizer', 'apiKey'] },
  { method: 'post', path: '/v1/bills/{id}/payments/{pid}/reject', tag: 'Pagamentos', summary: 'Recusar pagamento manual (ator humano)', auth: ['organizer', 'apiKey'] },
  { method: 'post', path: '/v1/bills/{id}/payments/{pid}/simulate', tag: 'Pagamentos', summary: 'Simular evento do sandbox (só com SANDBOX_ENABLED)', auth: readers, body: simulateSchema },
  { method: 'post', path: '/v1/refunds', tag: 'Pagamentos', summary: 'Estorno pelo provedor ou registro de devolução manual (D3)', auth: ['organizer', 'apiKey'], body: refundSchema, success: 201 },
  { method: 'post', path: '/v1/webhooks/payments/{provider}', tag: 'Pagamentos', summary: 'Webhook assinado do provedor de pagamento', auth: ['none'] },

  { method: 'post', path: '/v1/establishments', tag: 'Business', summary: 'Cadastrar estabelecimento', auth: ['apiKey'], body: establishmentSchema, success: 201 },
  { method: 'get', path: '/v1/establishments', tag: 'Business', summary: 'Listar estabelecimentos', auth: ['apiKey'] },
  { method: 'get', path: '/v1/reports/daily', tag: 'Business', summary: 'Conciliação do dia por estabelecimento', auth: ['apiKey'] },
  { method: 'post', path: '/v1/integrations/erp/{provider}/sync', tag: 'ERP', summary: 'Contrato canônico: criar/atualizar conta pelo ERP', auth: ['apiKey'], body: canonicalSyncSchema },
  { method: 'post', path: '/v1/integrations/erp/{provider}/ack', tag: 'ERP', summary: 'ERP confirma o processamento de um evento', auth: ['apiKey'], body: canonicalAckSchema },
  { method: 'post', path: '/v1/webhook-endpoints', tag: 'Webhooks', summary: 'Cadastrar destino de webhook (segredo aparece uma vez)', auth: ['apiKey'], body: webhookEndpointSchema, success: 201 },
  { method: 'get', path: '/v1/webhook-endpoints', tag: 'Webhooks', summary: 'Listar destinos', auth: ['apiKey'] },
  { method: 'get', path: '/v1/webhook-deliveries', tag: 'Webhooks', summary: 'Entregas e situação', auth: ['apiKey'] },
  { method: 'post', path: '/v1/webhook-deliveries/{id}/retry', tag: 'Webhooks', summary: 'Reprocessar entrega', auth: ['apiKey'] },

  { method: 'get', path: '/v1/knowledge', tag: 'Expert Library', summary: 'Listar conhecimento', auth: ['apiKey', 'admin'] },
  { method: 'get', path: '/v1/knowledge/resolve', tag: 'Expert Library', summary: 'Regra que vale agora, com proveniência', auth: ['apiKey', 'admin'] },
  { method: 'post', path: '/v1/knowledge', tag: 'Expert Library', summary: 'Propor nova versão (DRAFT)', auth: ['apiKey', 'admin'], body: knowledgeProposeSchema, success: 201 },
  { method: 'post', path: '/v1/knowledge/{id}/transition', tag: 'Expert Library', summary: 'REVIEW → APPROVED (quatro olhos) → ACTIVE, ou REVOKED', auth: ['apiKey', 'admin'], body: z.object({ to: z.enum(['REVIEW', 'DRAFT', 'APPROVED', 'ACTIVE', 'REVOKED']) }) },
  { method: 'get', path: '/v1/cbr/cases', tag: 'CBR', summary: 'Casos (admin informa tenantId)', auth: ['apiKey', 'admin'] },
  { method: 'get', path: '/v1/cbr/cases/{id}/similar', tag: 'CBR', summary: 'Casos parecidos (Jaccard)', auth: ['apiKey', 'admin'] },
  { method: 'post', path: '/v1/cbr/cases/{id}/resolve', tag: 'CBR', summary: 'Decisão humana do caso', auth: ['apiKey', 'admin'], body: z.object({ decision: z.string(), outcome: z.string() }) },
  { method: 'post', path: '/v1/cbr/proposals', tag: 'CBR', summary: 'Gerar propostas LEARNED dos padrões', auth: ['apiKey', 'admin'] },
  { method: 'get', path: '/v1/metrics', tag: 'Métricas', summary: 'North Star do mês (fuso de São Paulo)', auth: ['apiKey', 'admin'] },
  { method: 'get', path: '/v1/skills', tag: 'Assistência', summary: 'Manifesto das skills', auth: ['none'] },
];

const SECURITY: Record<Exclude<Auth, 'none'>, Record<string, string[]>[]> = {
  organizer: [{ organizerToken: [] }],
  guest: [{ shareToken: [] }],
  apiKey: [{ apiKey: [] }],
  admin: [{ adminToken: [], actorId: [] }],
};

export function buildOpenApi(publicBaseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const security = op.auth.flatMap((a) => (a === 'none' ? [{}] : SECURITY[a]));
    (paths[op.path] ??= {})[op.method] = {
      tags: [op.tag],
      summary: op.summary,
      security,
      parameters: [
        ...params,
        ...(op.idempotent ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 200 } }] : []),
      ],
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: json(op.body) } } } } : {}),
      responses: {
        [String(op.success ?? 200)]: { description: 'Sucesso' },
        default: { description: 'Erro', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'RachaPay API',
      version: '1.0.0',
      description:
        'Divisão, cobrança, pagamento e conciliação de despesas compartilhadas. Valores sempre em centavos inteiros. Erros: { error: { code, message, details, correlationId } }.',
    },
    servers: [{ url: publicBaseUrl }],
    paths,
    components: {
      securitySchemes: {
        organizerToken: { type: 'http', scheme: 'bearer', description: 'Token do organizador (rpo_…), devolvido ao criar a conta' },
        shareToken: { type: 'apiKey', in: 'header', name: 'X-Share-Token', description: 'Token de convidado (rps_…)' },
        apiKey: { type: 'http', scheme: 'bearer', description: 'Chave de API do estabelecimento (rpk_…); X-Actor-Id identifica a pessoa' },
        adminToken: { type: 'http', scheme: 'bearer', description: 'ADMIN_TOKEN da plataforma' },
        actorId: { type: 'apiKey', in: 'header', name: 'X-Actor-Id', description: 'Quem está operando (auditoria)' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' }, correlationId: { type: 'string' } },
              required: ['code', 'message', 'correlationId'],
            },
          },
        },
      },
    },
  };
}
