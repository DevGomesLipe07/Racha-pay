# 02 — Regras de negócio

> **Estado em 20/10/2026:** regras normativas — governam o comportamento que o código deverá ter. Nada aqui está implementado ainda; o acompanhamento fica em `04_RACHAPAY_IMPLEMENTATION_LOG.md`. Pontos que exigem decisão do proprietário estão no fim, em **Pontos em aberto** — as regras acima deles não foram alteradas.

As regras parametrizáveis vivem na **Expert Library** (`knowledge`), semeadas por `migrations/0003_seed_knowledge.sql`. Mudança de regra = nova versão via API (DRAFT → REVIEW → APPROVED → ACTIVE), nunca edição de código ou SQL.

## Despesa compartilhada (SharedBill)

Tipos: `RESTAURANT, TRANSPORT, TRAVEL, MARKET, EVENT, GIFT, FUEL, ACCOMMODATION, OTHER`. Mesa/comanda é `RESTAURANT` com `tableLabel` e referência externa do ERP.

Estados: `DRAFT → OPEN → PARTIALLY_PAID → SETTLEMENT_PENDING → SETTLED`, mais `REOPENED` (estava quitada e deixou de estar) e `CANCELLED`.

- Em `DRAFT` se editam participantes, itens e ajustes.
- **Confirmar divisão** grava uma fotografia imutável (`split_allocations`, versão N) e abre para pagamento. O cliente envia o total que viu na prévia; se a conta mudou, a confirmação é recusada (`STALE_PREVIEW`).
- **Editar divisão** (destravar) só sem pagamentos ativos ou recebidos.
- **Cancelar** só sem pagamentos ativos ou recebidos.

## Racha Engine

Modos: igual, por item, percentual (soma 100%) e valores manuais (soma = total).

1. Cada item é dividido entre os marcados, pelos pesos. Item sem ninguém marcado = todos.
2. `total = subtotal − desconto + serviço + gorjeta`.
3. Serviço = `bp × base`, base após desconto (`SERVICE_CHARGE.DEFAULT`), meio-para-cima no centavo. Padrão: 0% global; **10% em restaurantes** (regra de segmento). Máximo 30%.
4. Desconto e gorjeta proporcionais ao consumo (`DISCOUNT.ALLOCATION`, `TIP.ALLOCATION`).
5. Centavos por **maiores restos**; empate decidido pela ordem dos participantes. Exemplos: R$ 100,00 / 3 = 33,34 + 33,33 + 33,33; R$ 10,01 / 3 = 3,34 + 3,34 + 3,33.
6. Alocação cumulativa: o total de cada pessoa é a divisão justa do total da conta, e cada coluna (itens, desconto, serviço, gorjeta) fecha no centavo. Em casos raros um componente individual pode variar 1 centavo em relação ao proporcional exato; o total nunca.

## Pagamentos

- Toda criação exige `Idempotency-Key`. Mesmo key = mesmo pagamento (double click, retry).
- Valor ≤ saldo da parte (devido − pago − em processamento). A conta é travada durante a criação: dez abas pagando a mesma parte geram uma reserva.
- `AUTHORIZED` não quita. Só `CONFIRMED` conta como pago.
- Pendentes expiram (`PAYMENT.EXPIRY`): sandbox 30 min, manual 7 dias.
- **Manual** (Pix/dinheiro ao organizador): fica pendente até o organizador tocar "Recebi". Convidado nunca confirma o próprio pagamento.
- Eventos de provedor são monotônicos: confirmação depois de falha/expiração é aceita (dinheiro entrou) e gera caso `LATE_CONFIRMATION`; falha depois de confirmação é ignorada; estorno/chargeback antes da confirmação é **adiado** e reaplicado depois (`OUT_OF_ORDER_EVENT`).

## Conciliação (determinística)

Por conta: `TOTAL = PAGO + EM PROCESSAMENTO + ATRIBUÍDO NÃO PAGO + NÃO ATRIBUÍDO − EXCEDENTE`.

- Contabilidade **por participante**: o excedente de um não cobre a parte de outro ("pague a sua conta e de mais ninguém").
- **SETTLED** quando todo participante tem pago confirmado ≥ devido. Excedente vira `REFUND_DUE` + caso `OVERPAYMENT`, sem desfazer a quitação.
- Estorno ou chargeback depois de quitada: `REOPENED` + `BILL_REOPENED` no ledger.
- Se a invariante falhar (bug), a transação é abortada — nada é persistido.

## Ledger

Append-only, por conta, cada entrada com `prev_hash` e `entry_hash` (SHA-256 sobre JSON canônico). O banco proíbe UPDATE/DELETE/TRUNCATE. `GET /v1/bills/{id}/ledger` devolve a verificação da cadeia e a **reconstrução** de devido/pago a partir só do ledger.

## Expert Library

- Escopos: GLOBAL → COUNTRY → SEGMENT → ERP → PSP → TENANT → ESTABLISHMENT; vence a versão ativa e vigente mais específica.
- Conteúdo de chaves operacionais validado por schema antes de aprovar.
- Regra crítica exige aprovador diferente do autor (quatro olhos). Aprovar/ativar exige ator humano. Escopos compartilhados só pelo administrador da plataforma.

## CBR (aprendizado controlado)

Exceções viram casos (`OVERPAYMENT, LATE_CONFIRMATION, OUT_OF_ORDER_EVENT, CHARGEBACK, REFUND_AFTER_SETTLEMENT, ERP_DIVERGENCE, MANUAL_PAYMENT_REJECTED`). Um humano resolve (decisão + resultado). Três ou mais casos do mesmo tipo com a mesma decisão geram uma **proposta** em DRAFT, origem LEARNED, com os casos como evidência. Nada é ativado automaticamente.

## North Star

Rachas completamente quitados por mês (`GET /v1/metrics`), com taxa de conclusão, participantes médios, mediana até quitação, TPV e exceções.

## Pontos em aberto (decisão do proprietário)

Identificados na análise de 20/10/2026. Nenhuma regra acima foi mudada por causa deles.

1. **`SETTLED` e `NÃO ATRIBUÍDO`.** A quitação olha só os participantes, mas a fórmula da conciliação tem o termo `NÃO ATRIBUÍDO`. Proposta: a confirmação da divisão exige `NÃO ATRIBUÍDO = 0`, e `SETTLED` passa a exigir também esse termo zerado — assim nunca há quitação com dinheiro sem dono.
2. **Itens depois de pagamento parcial.** Destravar a divisão só é permitido sem pagamentos; no restaurante é comum "mais uma rodada" depois que alguém já pagou, e via ERP isso vira `409 ERP_DIVERGENCE` com a mesa travada. Falta uma regra de **complemento** (nova versão da divisão só com o acréscimo, preservando o que já foi pago).
3. **Devolução de `REFUND_DUE` no pagamento manual.** Não há caminho definido para devolver excedente quando o pagamento foi Pix/dinheiro ao organizador (o estorno via PSP também não existe). Proposta: o organizador registra "devolvi", gerando evento compensatório no ledger e encerrando o caso `OVERPAYMENT`.
4. **Gorjeta proporcional ao consumo.** É a regra atual (`TIP.ALLOCATION`); como é parametrizável, vale validar com usuários se o padrão deveria ser divisão igual.
