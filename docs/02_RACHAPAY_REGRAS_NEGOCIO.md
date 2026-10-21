# 02 — Regras de negócio

> **Estado em 21/10/2026:** regras normativas — governam o comportamento do código; o que já está implementado e provado fica em `04_RACHAPAY_IMPLEMENTATION_LOG.md`. As lacunas encontradas na análise foram decididas pelo proprietário em 21/10/2026 e estão na seção **Decisões D1–D20** no fim; quando uma decisão completa ou muda uma regra acima, a regra cita a decisão.

As regras parametrizáveis vivem na **Expert Library** (`knowledge`), semeadas por `migrations/0003_seed_knowledge.sql`. Mudança de regra = nova versão via API (DRAFT → REVIEW → APPROVED → ACTIVE), nunca edição de código ou SQL.

## Despesa compartilhada (SharedBill)

Tipos: `RESTAURANT, TRANSPORT, TRAVEL, MARKET, EVENT, GIFT, FUEL, ACCOMMODATION, OTHER`. Mesa/comanda é `RESTAURANT` com `tableLabel` e referência externa do ERP.

Estados: `DRAFT → OPEN → PARTIALLY_PAID → SETTLEMENT_PENDING → SETTLED`, mais `REOPENED` (estava quitada e deixou de estar) e `CANCELLED`. Definição exata de cada estado: **D6**.

Modelo de cobrança (**D5**): `ORGANIZER_COLLECTS` (o organizador pagou o estabelecimento e cobra os demais — padrão do RachaPay Pessoal) ou `MERCHANT_COLLECTS` (cada participante paga o estabelecimento — padrão Business/ERP).

- Em `DRAFT` se editam participantes, itens e ajustes.
- **Confirmar divisão** grava uma fotografia imutável (`split_allocations`, versão N) e abre para pagamento. O cliente envia o total que viu na prévia; se a conta mudou, a confirmação é recusada (`STALE_PREVIEW`).
- **Editar divisão** (destravar) só sem pagamentos ativos ou recebidos. Com pagamentos, acréscimos entram como **complemento** (**D2**).
- **Cancelar** só sem pagamentos ativos ou recebidos.

## Racha Engine

Modos: igual, por item, percentual (soma 100%) e valores manuais (soma = total). Percentual e manual dividem o **total final** (após desconto, serviço e gorjeta); percentual em pontos-base, soma = 10.000 (**D7**).

1. Cada item é dividido entre os marcados, pelos pesos. Item sem ninguém marcado = todos.
2. `total = subtotal − desconto + serviço + gorjeta`.
3. Serviço = `bp × base`, base após desconto (`SERVICE_CHARGE.DEFAULT`), meio-para-cima no centavo. Padrão: 0% global; **10% em restaurantes** (regra de segmento). Máximo 30%.
4. Desconto e gorjeta proporcionais ao consumo (`DISCOUNT.ALLOCATION`, `TIP.ALLOCATION`).
5. Centavos por **maiores restos**; empate decidido pela ordem dos participantes. Exemplos: R$ 100,00 / 3 = 33,34 + 33,33 + 33,33; R$ 10,01 / 3 = 3,34 + 3,34 + 3,33.
6. Alocação cumulativa: o total de cada pessoa é a divisão justa do total da conta, e cada coluna (itens, desconto, serviço, gorjeta) fecha no centavo. Nenhum componente fica negativo. Um componente individual pode se afastar do proporcional exato em menos de 2 centavos (máximo medido: 1,21 centavo em 3.500 cenários aleatórios); o total nunca.
7. Por item, o consumo de cada pessoa é somado de forma exata (racional) e arredondado **uma vez** — arredondar item a item faria o primeiro participante ganhar 1 centavo em cada item.

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
- **SETTLED** quando `NÃO ATRIBUÍDO = 0` e todo participante tem pago confirmado ≥ devido (**D1**). Excedente vira `REFUND_DUE` + caso `OVERPAYMENT`, sem desfazer a quitação; devolução manual em **D3**.
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

## Decisões D1–D20 (proprietário, 21/10/2026)

Lacunas encontradas na análise de 20/10/2026, decididas e agora normativas.

**Dinheiro e estados**

- **D1 — Quitação exige tudo atribuído.** A confirmação da divisão só é aceita com `NÃO ATRIBUÍDO = 0` (o engine garante por construção), e `SETTLED` exige esse termo zerado. Nunca há quitação com dinheiro sem dono.
- **D2 — Complemento.** Com pagamentos ativos ou recebidos, acréscimos (nova rodada, item novo) geram a versão N+1 da divisão = versão N + divisão **só do acréscimo** (o engine roda sobre os itens novos, com a mesma regra de serviço; desconto e gorjeta já alocados não mudam). Em conta no modo MANUAL, o acréscimo é dividido por item (itens sem marcação = todos). Nada já pago é redistribuído. Estado volta a `OPEN`/`PARTIALLY_PAID` conforme D6; se estava `SETTLED`, vira `REOPENED`. Ledger: `SPLIT_COMPLEMENTED`. Alterar ou remover item **já confirmado** continua proibido (via ERP: `409 ERP_DIVERGENCE` + caso CBR); só acréscimo vira complemento.
- **D3 — Devolução manual.** Em pagamento manual, o organizador registra "devolvi" para o excedente de um participante: evento compensatório `REFUND_RECORDED` no ledger, `REFUND_DUE` zera e o caso `OVERPAYMENT` é resolvido. Valor ≤ excedente.
- **D4 — Gorjeta proporcional ao consumo** mantida como padrão (`TIP.ALLOCATION`), alterável pela Expert Library.
- **D5 — Modelo de cobrança.** `ORGANIZER_COLLECTS` (padrão do tenant Pessoal): o organizador é participante marcado como tal e já pagou o estabelecimento; na confirmação, a parte dele nasce quitada pelo evento `ORGANIZER_SHARE_SELF_SETTLED` (não é pagamento, não entra no TPV). `MERCHANT_COLLECTS` (padrão Business/ERP): ninguém nasce quitado. O modelo é fixado na criação da conta.
- **D6 — Estados exatos** (avaliados a cada evento, só por regra determinística):
  - `DRAFT`: divisão não confirmada.
  - `OPEN`: divisão confirmada, nenhum valor confirmado além do autoquitado (D5).
  - `PARTIALLY_PAID`: há valor confirmado, mas algum participante tem confirmado + em processamento < devido.
  - `SETTLEMENT_PENDING`: todo participante tem confirmado + em processamento ≥ devido, e pelo menos um ainda depende de valor em processamento.
  - `SETTLED`: D1 + todo participante com confirmado ≥ devido.
  - `REOPENED`: estava `SETTLED` e deixou de cumprir a regra (estorno, chargeback, complemento). Sai de `REOPENED` para `SETTLED` quando volta a cumprir.
  - `CANCELLED`: terminal.
- **D7 — Percentual e manual sobre o total final.** Percentual em pontos-base (1 bp = 0,01%), soma = 10.000; manual com soma = total final. Arredondamento por maiores restos.
- **D8 — Remover participante** só em `DRAFT` e sem pagamentos; os itens em que ele era o único marcado voltam a ser de todos.

**Identidade e segurança**

- **D9 — RLS por tenant e por conta.** Requisições com token de capacidade (`rpo_`, `rps_`) abrem a sessão do banco com o tenant **e** o `bill_id` do token; as políticas RLS conferem os dois. Um bug de autorização não expõe outra conta do tenant Pessoal.
- **D10 — Token do organizador perdido = acesso perdido** na V1 (o histórico fica no aparelho). Documentado na interface; recuperação entra com contas opcionais.
- **D11 — Criação anônima limitada** por IP em memória, sem armazenar IP (valor inicial na Expert Library: `RATE_LIMIT.ANON_BILL_CREATE`).
- **D12 — Idempotência.** Escopo `(tenant, Idempotency-Key)`, validade 24 h (`IDEMPOTENCY.TTL`). Mesma chave + mesmo corpo = mesma resposta (inclusive erro de regra, com cabeçalho `Idempotent-Replayed: true`); mesma chave + corpo diferente = `422 IDEMPOTENCY_MISMATCH`. Com token de capacidade o escopo é `(tenant, conta, chave)`, porque o tenant Pessoal é compartilhado.

**Técnicas**

- **D13 — Ledger: lista fechada de eventos.** `BILL_CREATED, SPLIT_CONFIRMED, SPLIT_COMPLEMENTED, SPLIT_UNLOCKED, ORGANIZER_SHARE_SELF_SETTLED, PAYMENT_CREATED, PAYMENT_PENDING, PAYMENT_AUTHORIZED, PAYMENT_CONFIRMED, PAYMENT_FAILED, PAYMENT_EXPIRED, PAYMENT_REJECTED, PAYMENT_REFUNDED, PAYMENT_CHARGEDBACK, REFUND_RECORDED, BILL_STATE_CHANGED, BILL_CANCELLED, ERP_ACKNOWLEDGED`. Tipo novo exige versão nova desta lista. A reconstrução de devido/pago usa só o ledger.
- **D14 — Dinheiro na fronteira.** Banco `bigint`; domínio `BigInt`; API em centavos como inteiro JSON, validado entre 0 e 100.000.000.000 (R$ 1 bilhão, abaixo de 2^53). Nunca float.
- **D15 — Tempo.** Relógio injetável no domínio e nos serviços (expiração testável); métricas mensais em `America/Sao_Paulo`.
- **D16 — Dois papéis no banco** (21/10/2026). `rachapay_owner` é dono do schema e só roda migrations (`MIGRATION_DATABASE_URL`); `rachapay_app` é o da aplicação (`DATABASE_URL`) e só recebe DML — no histórico financeiro, só `INSERT`/`SELECT`. Os dois sem superuser e sem BYPASSRLS. Assim a aplicação não consegue desligar RLS nem remover as triggers do ledger. Em produção o servidor recusa subir se o papel da aplicação for superuser, BYPASSRLS ou dono das tabelas.
- **D18 — IA pelo SDK oficial, só no adapter** (21/10/2026). A leitura de cupom por foto usa o SDK `@anthropic-ai/sdk` (0.133.0, fixado) **apenas** em `src/modules/ai/anthropic-provider.ts`, atrás da interface `AIProvider`; o domínio nunca o importa. Substitui o "adapter HTTP puro" do plano anterior, que só existia por falta de npm. Modelo padrão `claude-sonnet-5-5` (configurável por `AI_MODEL`), saída estruturada validada por schema, fallback de recusa no servidor (`fallbacks: "default"`). Padrão do sistema: IA desligada (`AI_PROVIDER=none`).
- **D19 — Volume da North Star separado por natureza** (21/10/2026). `GET /v1/metrics` reporta `declaredManualCents` (Pix/dinheiro ao organizador — o RachaPay não viu o dinheiro), `sandboxTestCents` (teste) e `providerCents` (PSP real). Nunca somados num "TPV" único.
- **D20 — Novo link de convidado** (21/10/2026). O token só existe em hash, então não é recuperável; o organizador pode emitir um novo (`POST /v1/bills/{id}/share-links`), e o anterior continua válido.
- **D17 — Retentativa de webhook de saída** (21/10/2026). 12 tentativas, 10 s dobrando, intervalo máximo 6 h: janela total ≈ 5,7 h, depois `DEAD` (reprocessável). Regra `WEBHOOK.RETRY` na Expert Library. Resolve a conta impossível "8 tentativas … até 6 h".
