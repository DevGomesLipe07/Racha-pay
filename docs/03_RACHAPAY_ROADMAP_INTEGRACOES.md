# 03 — API, integrações e roadmap

> **Estado em 21/10/2026:** as 44 rotas especificadas estão implementadas e cobertas por teste de integração, mais uma rota nova (`share-links`, D20). O que continua bloqueado depende de terceiros: PSP real e adapter nativo do NexFlow. Detalhe em `04`.

## Autenticação

| Quem | Como |
|---|---|
| Organizador | `Authorization: Bearer rpo_…` (devolvido ao criar a conta) |
| Convidado | `X-Share-Token: rps_…` |
| Sistema/estabelecimento | `Authorization: Bearer rpk_…` (`npm run tenant:create -- --name "…"`); escopos e `actor_type` (HUMAN, SYSTEM, AI) por chave; `X-Actor-Id` identifica a pessoa para auditoria |
| Administrador da plataforma | `Authorization: Bearer <ADMIN_TOKEN>` + `X-Actor-Id` (obrigatório) |

Erros: `{ "error": { "code", "message", "details", "correlationId" } }`.

Escopos de chave usados pela Policy Engine: `bills:read`, `bills:write`, `payments:create`, `payments:write`, `erp:sync`, `establishments:write`, `webhooks:write`, `knowledge:read`, `knowledge:write`, `knowledge:approve`, `cbr:read`, `cbr:write`, `metrics:read`, `ai:use`. Ações que exigem ator **humano** (chave `HUMAN`): confirmar/recusar pagamento manual, registrar devolução manual, aprovar/ativar conhecimento, resolver caso CBR. Chave `AI` nunca executa ação financeira crítica.

## Rotas

```
GET  /health  /ready  /v1/config
POST /v1/bills                                criar (anônimo = Pessoal; chave = tenant)
GET  /v1/bills/{id}         PATCH /v1/bills/{id}         POST /v1/bills/{id}/cancel
POST /v1/bills/{id}/share-links               novo link de convidado (D20)
POST /v1/bills/{id}/participants      PATCH|DELETE /v1/bills/{id}/participants/{pid}
POST /v1/bills/{id}/items             PUT /v1/bills/{id}/items/{itemId}/assignees   DELETE …/items/{itemId}
POST /v1/bills/{id}/splits/preview    POST /v1/bills/{id}/splits (confirma ou complementa, D2)   POST /v1/bills/{id}/splits/unlock
GET  /v1/bills/{id}/reconciliation    GET /v1/bills/{id}/ledger     GET /v1/bills/{id}/explanation
POST /v1/bills/{id}/receipt           sugestão de itens: { text } ou { image } — nada é gravado
POST /v1/payments                     (header Idempotency-Key)
POST /v1/bills/{id}/payments/{pid}/confirm|reject     (humano; pagamento MANUAL)
POST /v1/refunds                      (kind PROVIDER ou MANUAL_RECORD)
POST /v1/webhooks/payments/{provider} (entrada assinada; hoje só `sandbox`)
POST /v1/bills/{id}/payments/{pid}/simulate           (só com SANDBOX_ENABLED; passa pelo caminho do webhook)
POST|GET /v1/establishments
POST /v1/integrations/erp/{provider}/sync   POST /v1/integrations/erp/{provider}/ack
POST|GET /v1/webhook-endpoints   GET /v1/webhook-deliveries   POST /v1/webhook-deliveries/{id}/retry
GET  /v1/knowledge   GET /v1/knowledge/resolve   POST /v1/knowledge   POST /v1/knowledge/{id}/transition
GET  /v1/cbr/cases   GET /v1/cbr/cases/{id}/similar   POST /v1/cbr/cases/{id}/resolve   POST /v1/cbr/proposals
GET  /v1/metrics     GET /v1/skills
```

A Web/PWA é servida em `/` (arquivos de `public/`, CSP estrita, sem build).

### Pagamentos

- `POST /v1/payments` `{ billId, participantId, method: "MANUAL" | "SANDBOX", amountCents? }` + `Idempotency-Key`. Sem `amountCents`, cobra o saldo disponível da parte. Valor acima do saldo → `409 AMOUNT_EXCEEDS_BALANCE`; parte sem saldo (paga ou reservada) → `409 NOTHING_TO_PAY`. A repetição da mesma chave devolve a mesma resposta com `Idempotent-Replayed: true`.
- Provedor (sandbox hoje, PSP depois): fase 1 reserva `CREATED` com a conta travada; fase 2 chama o provedor **fora** da trava e grava `PENDING` + referência. Falha do provedor → `FAILED` e `502`.
- `POST /v1/refunds`:
  - `{ kind: "PROVIDER", billId, paymentId, amountCents? }` — estorno pelo provedor (sandbox confirma na hora; provedor não implementado → `501 REFUND_NOT_AVAILABLE`; pagamento manual → `422 USE_MANUAL_REFUND_RECORD`).
  - `{ kind: "MANUAL_RECORD", billId, participantId, amountCents }` — D3: organizador registra que devolveu o excedente; limitado ao `REFUND_DUE`.
- Webhook do sandbox: `X-Sandbox-Signature: t=<unix>,v1=<hmac>` com `HMAC_SHA256(SANDBOX_WEBHOOK_SECRET, "<t>.<corpo bruto>")`, janela de 5 min; corpo `{ eventId, reference, kind, amountCents? }`. Duplicado por `(provider, eventId)` → `200 { duplicate: true }` sem efeito.

### Assistência e métricas

- `POST /v1/bills/{id}/receipt` — `{ "text": "…" }` (parser determinístico, sempre disponível) ou `{ "image": { "mediaType": "image/jpeg|image/png|image/webp", "data": "<base64>" } }` (até 5 MB; exige `AI_PROVIDER=anthropic`, senão `501 AI_DISABLED`). Resposta `{ suggestion: { source, items[{description, quantity, unitPriceCents, lineTotalCents}], unparsed, printedTotalCents, warnings, requiresConfirmation: true } }`. Recusa/falha da IA → `503` com código (`AI_REFUSED`, `AI_UNAVAILABLE`…).
- `GET /v1/bills/{id}/explanation` — frases em português derivadas só da conciliação (sem LLM).
- `GET /v1/metrics?month=YYYY-MM` — chave do tenant (`metrics:read`) ou admin com `tenantId`. Mês no fuso `America/Sao_Paulo`; volume separado em declarado (manual), teste (sandbox) e provedor (D19).

### Expert Library e CBR

- `POST /v1/knowledge` `{ key, scopeType, scopeValue, content, rationale, validFrom?, validTo? }` → DRAFT, conteúdo validado pelo schema da chave. Chave de tenant: escopos `TENANT`/`ESTABLISHMENT`; admin: `GLOBAL`, `COUNTRY`, `SEGMENT`, `ERP`, `PSP`.
- `POST /v1/knowledge/{id}/transition` `{ to: "REVIEW" | "DRAFT" | "APPROVED" | "ACTIVE" | "REVOKED" }`. Aprovar exige humano e, em regra crítica, aprovador ≠ autor; ativar aposenta a versão ativa anterior (`SUPERSEDED`).
- `GET /v1/knowledge/resolve?key=…&segment=…&establishmentId=…` — a regra que vale agora, com proveniência.
- `POST /v1/cbr/cases/{id}/resolve` `{ decision, outcome }` (humano). Três casos do mesmo tipo com a mesma decisão geram proposta `CBR_PLAYBOOK.<TIPO>` em DRAFT (origem LEARNED), que segue o fluxo humano normal.

## Contrato canônico de ERP (NexFlow e qualquer outro)

`POST /v1/integrations/erp/generic/sync` com chave de escopo `erp:sync`:

```json
{
  "externalReference": "comanda-42",
  "establishmentExternalId": "loja-centro",
  "tableLabel": "12",
  "kind": "RESTAURANT",
  "currency": "BRL",
  "title": "Mesa 12",
  "participants": ["Cliente 1", "Cliente 2"],
  "items": [
    { "externalRef": "p1", "description": "Picanha", "unitPriceCents": 8990, "quantity": 1 }
  ],
  "discountCents": 0,
  "serviceBp": 1000,
  "tipCents": 0
}
```

`title` e `participants` são opcionais (só na criação); `externalRef` é obrigatório e único por item; o estabelecimento precisa estar cadastrado (`POST /v1/establishments`).

- Idempotente por `externalReference`: `CREATED` (`201`, devolve `shareUrl` para o QR da mesa), `UNCHANGED`, `UPDATED` (rascunho: itens alterados/removidos/novos e ajustes).
- Depois da divisão confirmada: só **acréscimo** de itens é aceito e vira complemento confirmado na hora (`COMPLEMENTED`, D2; a chave precisa também de `bills:write`, senão `409 COMPLEMENT_NOT_ALLOWED`). Alterar ou remover item confirmado, ou mudar desconto/serviço/gorjeta → `409 ERP_DIVERGENCE` + caso CBR; a conta não muda.
- Baixa no ERP: assine `payment.confirmed` (baixa parcial, traz `participantId` e `amountCents`) e `bill.settled` (fechar mesa).
- Confirmação do ERP: `POST …/ack { externalReference, event, erpDocument }` → ledger `ERP_ACKNOWLEDGED`.
- **NexFlow**: pode integrar hoje mandando este payload para `generic`. `/v1/integrations/erp/nexflow/*` responde `501 ERP_ADAPTER_BLOCKED`: a especificação da API do NexFlow existe (vault VHAREN, `NexFlow/.mds dev/ERP_COMPLETO.md` § 6), mas ele é um ERP de serviços (vendas, contas a receber, Pix via Bradesco/Inter, NFS-e) **sem conceito de mesa ou comanda** — falta decidir o que, no NexFlow, vira uma conta.

## Webhooks de saída

Cadastro: `POST /v1/webhook-endpoints { url, events?, description? }` → o segredo `whsec_…` aparece uma vez e é guardado cifrado (AES-256-GCM). Em produção: só `https` para destino público (checado no cadastro e de novo na entrega).

Corpo: `{ "id", "type", "version": "2026-10-01", "createdAt", "data" }` — `data` traz `billId`, `externalReference`, `tableLabel`, `billState`, `ledgerSeq`, `ledgerHash` e os campos do lançamento.
Cabeçalhos: `X-RachaPay-Event`, `X-RachaPay-Event-Id` (deduplique por ele), `X-RachaPay-Delivery`, `X-RachaPay-Signature: t=<unix>,v1=<hmac>`.
Verificação: `HMAC_SHA256(secret, "<t>.<corpo bruto>")`, rejeite `t` com mais de 5 min.
Entrega at-least-once pelo worker (ciclo de 10 s), até 12 tentativas (10 s, 20 s, 40 s… — janela total ≈ 5,7 h, D17), depois `DEAD`; `POST /v1/webhook-deliveries/{id}/retry` reprocessa. Os eventos nascem do ledger, na mesma transação (outbox).

Eventos: `bill.created, split.confirmed, payment.created, payment.confirmed, payment.failed, payment.refunded, payment.chargedback, bill.partially_paid, bill.settled, bill.reopened, bill.cancelled`.

## Integrar um PSP real (próximo grande passo)

1. Escolher PSP com Pix + split de recebíveis, contrato e credenciais de sandbox.
2. Implementar `PaymentProvider` (`src/modules/payments/providers.ts`): `createPayment` (cobrança Pix/checkout tokenizado) e `verifyWebhook` (assinatura do PSP → `ProviderEvent`), e registrá-lo em `createProviderRegistry`.
3. O fluxo em duas fases já existe: `CREATED` com a conta travada → chamada ao PSP **fora** da trava → `PENDING` com a referência e roteamento do webhook.
4. Estorno via API do PSP em `requestProviderRefund` (hoje: `501 REFUND_NOT_AVAILABLE` para provedor não implementado).
5. Liquidação/split financeiro: configurada no PSP; o dinheiro não passa pela conta do RachaPay.
6. Registrar `PAYMENT.EXPIRY` específico do PSP na Expert Library (escopo PSP, pelo administrador).

## Roadmap por camadas (do Guia Mestre) e situação

| Etapa | Situação em 21/10/2026 |
|---|---|
| E0 constituição/domínio | IMPLEMENTADO — SharedBill, estados D6, Policy Engine |
| E1 Split Engine | IMPLEMENTADO — 4 modos, maiores restos, propriedade com 3.500 cenários |
| E2 Web/PWA + compartilhamento | IMPLEMENTADO — organizador e convidado, QR local, WhatsApp, selo, E2E em Chromium |
| E3 Ledger + conciliação | IMPLEMENTADO — cadeia de hash, imutável no banco, reconstrução |
| E4 Pagamento piloto | manual + sandbox IMPLEMENTADO; PSP real BLOQUEADO (parceiro) |
| E5 Business + NexFlow | API Business, estabelecimentos, ERP canônico e webhooks de saída IMPLEMENTADO; **painel web Business** PENDENTE; adapter NexFlow BLOQUEADO (decisão de domínio) |
| E6–E11 | pendentes, conforme Go/No-Go do Guia Mestre §35 |
