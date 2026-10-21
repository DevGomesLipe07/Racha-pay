# 03 — API, integrações e roadmap

> **Estado em 21/10/2026:** 24 das 44 rotas estão implementadas e cobertas por teste de integração (marcadas ✅ abaixo). As demais continuam sendo especificação. A tabela de roadmap no fim mostra a situação real; o detalhe está em `04`.

## Autenticação

| Quem | Como |
|---|---|
| Organizador | `Authorization: Bearer rpo_…` (devolvido ao criar a conta) |
| Convidado | `X-Share-Token: rps_…` |
| Sistema/estabelecimento | `Authorization: Bearer rpk_…` (`npm run tenant:create -- --name "…"`); escopos e `actor_type` (HUMAN, SYSTEM, AI) por chave; `X-Actor-Id` identifica a pessoa para auditoria |
| Administrador da plataforma | `Authorization: Bearer <ADMIN_TOKEN>` + `X-Actor-Id` |

Erros: `{ "error": { "code", "message", "details", "correlationId" } }`.

## Rotas (44)

```
✅ GET  /health  /ready  /v1/config
✅ POST /v1/bills                                criar (anônimo = Pessoal; chave = tenant)
✅ GET  /v1/bills/{id}      ✅ PATCH /v1/bills/{id}      ✅ POST /v1/bills/{id}/cancel
✅ POST /v1/bills/{id}/participants   ✅ PATCH|DELETE /v1/bills/{id}/participants/{pid}
✅ POST /v1/bills/{id}/items          ✅ PUT /v1/bills/{id}/items/{itemId}/assignees   ✅ DELETE …/items/{itemId}
✅ POST /v1/bills/{id}/splits/preview ✅ POST /v1/bills/{id}/splits (confirma ou complementa, D2)   ✅ POST /v1/bills/{id}/splits/unlock
✅ GET  /v1/bills/{id}/reconciliation ✅ GET /v1/bills/{id}/ledger     ⏳ GET /v1/bills/{id}/explanation
⏳ POST /v1/bills/{id}/receipt        (sugestão de itens: texto ou foto)
✅ POST /v1/payments                  (header Idempotency-Key)
✅ POST /v1/bills/{id}/payments/{pid}/confirm|reject     (organizador, pagamento MANUAL)
✅ POST /v1/refunds                   (kind PROVIDER ou MANUAL_RECORD, abaixo)
✅ POST /v1/webhooks/payments/{provider}                 (entrada assinada; hoje só `sandbox`)
✅ POST /v1/bills/{id}/payments/{pid}/simulate           (só com SANDBOX_ENABLED; passa pelo caminho do webhook)
⏳ POST|GET /v1/establishments
⏳ POST /v1/integrations/erp/{provider}/sync   ⏳ POST /v1/integrations/erp/{provider}/ack
⏳ POST|GET /v1/webhook-endpoints   ⏳ GET /v1/webhook-deliveries   ⏳ POST /v1/webhook-deliveries/{id}/retry
⏳ GET  /v1/knowledge   ⏳ GET /v1/knowledge/resolve   ⏳ POST /v1/knowledge   ⏳ POST /v1/knowledge/{id}/transition
⏳ GET  /v1/cbr/cases   ⏳ GET /v1/cbr/cases/{id}/similar   ⏳ POST /v1/cbr/cases/{id}/resolve   ⏳ POST /v1/cbr/proposals
⏳ GET  /v1/metrics     ⏳ GET /v1/skills
```

(✅ = implementada e com teste de integração · ⏳ = especificada, ainda não implementada)

### Pagamentos — contrato implementado

- `POST /v1/payments` `{ billId, participantId, method: "MANUAL" | "SANDBOX", amountCents? }` + `Idempotency-Key`. Sem `amountCents`, cobra o saldo disponível da parte. Valor acima do saldo → `409 AMOUNT_EXCEEDS_BALANCE`; parte sem saldo (paga ou reservada) → `409 NOTHING_TO_PAY`.
- Provedor (sandbox hoje, PSP depois): fase 1 reserva `CREATED` com a conta travada; fase 2 chama o provedor **fora** da trava e grava `PENDING` + referência. Falha do provedor → `FAILED` e `502`.
- `POST /v1/refunds`:
  - `{ kind: "PROVIDER", billId, paymentId, amountCents? }` — estorno pelo provedor (sandbox confirma na hora; provedor não implementado → `501 REFUND_NOT_AVAILABLE`; pagamento manual → `422 USE_MANUAL_REFUND_RECORD`).
  - `{ kind: "MANUAL_RECORD", billId, participantId, amountCents }` — D3: organizador registra que devolveu o excedente; limitado ao `REFUND_DUE`.
- Webhook do sandbox: `X-Sandbox-Signature: t=<unix>,v1=<hmac>` com `HMAC_SHA256(SANDBOX_WEBHOOK_SECRET, "<t>.<corpo bruto>")`, janela de 5 min; corpo `{ eventId, reference, kind, amountCents? }`. Duplicado por `(provider, eventId)` → `200 { duplicate: true }` sem efeito.

## Contrato canônico de ERP (NexFlow e qualquer outro)

`POST /v1/integrations/erp/generic/sync` com chave de escopo `erp:sync`:

```json
{
  "externalReference": "comanda-42",
  "establishmentExternalId": "loja-centro",
  "tableLabel": "12",
  "kind": "RESTAURANT",
  "currency": "BRL",
  "items": [
    { "externalRef": "p1", "description": "Picanha", "unitPriceCents": 8990, "quantity": 1 }
  ],
  "discountCents": 0,
  "serviceBp": 1000,
  "tipCents": 0
}
```

- Idempotente por `externalReference`: `CREATED` (devolve `shareUrl` para o QR da mesa), `UNCHANGED`, `UPDATED` (enquanto em edição).
- Depois da divisão confirmada, mudança de itens → `409 ERP_DIVERGENCE` + caso CBR (ver ponto em aberto 2 em `02`).
- Baixa no ERP: assine `payment.confirmed` (baixa parcial, traz `participantId` e `amountCents`) e `bill.settled` (fechar mesa).
- Confirmação do ERP: `POST …/ack { externalReference, event, erpDocument }` → ledger `ERP_ACKNOWLEDGED`.
- **NexFlow**: poderá integrar mandando este payload. A especificação da API do NexFlow existe (vault VHAREN, `NexFlow/.mds dev/ERP_COMPLETO.md` § 6): é um ERP de serviços (vendas, contas a receber, formas de pagamento, Pix via Bradesco/Inter, NFS-e) **sem conceito de mesa ou comanda**. O adapter próprio (`ERPAdapter`) continua **BLOQUEADO** — agora por decisão de encaixe de domínio (o que, no NexFlow, vira uma SharedBill), não por falta de documento.

## Webhooks de saída

Corpo: `{ "id", "type", "version": "2026-10-01", "createdAt", "data" }`.
Cabeçalhos: `X-RachaPay-Event`, `X-RachaPay-Event-Id` (deduplique por ele), `X-RachaPay-Delivery`, `X-RachaPay-Signature: t=<unix>,v1=<hmac>`.
Verificação: `HMAC_SHA256(secret, "<t>.<corpo bruto>")`, rejeite `t` com mais de 5 min.
Entrega at-least-once, até 12 tentativas (10 s, 20 s, 40 s… — janela total ≈ 5,7 h), depois `DEAD`; reprocessável. Decisão **D17**; regra `WEBHOOK.RETRY` na Expert Library (já semeada; a entrega em si ainda é ⏳).

Eventos: `bill.created, split.confirmed, payment.created, payment.confirmed, payment.failed, payment.refunded, payment.chargedback, bill.partially_paid, bill.settled, bill.reopened, bill.cancelled`.

## Integrar um PSP real (próximo grande passo depois do Ciclo 1)

1. Escolher PSP com Pix + split de recebíveis, contrato e credenciais de sandbox.
2. Implementar `PaymentProvider` em `modules/payments/providers.ts`: `createPayment` (cobrança Pix/checkout tokenizado) e `verifyWebhook` (assinatura do PSP → `ProviderEvent`).
3. Para PSP remoto: criar o pagamento como `CREATED`, efetivar a transação, chamar o PSP **fora** da trava da conta e atualizar para `PENDING` com a referência.
4. Estorno via API do PSP em `requestRefund` (para provedores não implementados, responder 501 `REFUND_NOT_AVAILABLE`).
5. Liquidação/split financeiro: configurada no PSP; o dinheiro não passa pela conta do RachaPay.
6. Registrar `PAYMENT.EXPIRY` específico do PSP na Expert Library (escopo PSP).

## Roadmap por camadas (do Guia Mestre) e situação

| Etapa | Situação em 21/10/2026 |
|---|---|
| E0 constituição/domínio | IMPLEMENTADO — SharedBill, estados D6, Policy Engine |
| E1 Split Engine | IMPLEMENTADO — 4 modos, maiores restos, propriedade com 3.500 cenários |
| E2 Web/PWA + compartilhamento | PARCIAL — API e links com token no `#` prontos; interface PWA PENDENTE |
| E3 Ledger + conciliação | IMPLEMENTADO — cadeia de hash, imutável no banco, reconstrução |
| E4 Pagamento piloto | manual + sandbox IMPLEMENTADO; PSP real BLOQUEADO (parceiro) |
| E5 Business + NexFlow | chave de API por tenant IMPLEMENTADO; estabelecimentos, ERP canônico, webhooks de saída e painel PENDENTE; adapter NexFlow BLOQUEADO (decisão de domínio) |
| E6–E11 | pendentes, conforme Go/No-Go do Guia Mestre §35 |
