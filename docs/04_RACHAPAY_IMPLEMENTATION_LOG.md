# 04 — Implementation Log

Registra só o que foi **efetivamente feito e provado**. Status permitidos: IMPLEMENTADO, PARCIAL, BLOQUEADO, PENDENTE.

---

## Ciclo 1 — 21/10/2026 — núcleo financeiro (fatias S1–S5)

**Objetivo:** construir de verdade o núcleo do monólito — uma conta vai de "criada" a "RACHA QUITADO" pela API, com ledger, conciliação e testes —, na ordem decidida pelo proprietário (núcleo primeiro; "sempre siga com as melhores decisões").

### Arqueologia / validação

Repositório só com documentação (Ciclo 0). Todas as decisões abertas do Ciclo 0 foram decididas pelo proprietário (D1–D15) e duas foram acrescentadas durante a implementação (D16, D17) — todas em `02 § Decisões`.

### Decisões de implementação

| Decisão | Motivo |
|---|---|
| D16: papéis `rachapay_owner` (migrations) e `rachapay_app` (aplicação) | com um papel só, a aplicação poderia desligar RLS ou apagar triggers do ledger |
| D17: webhooks de saída com 12 tentativas, 10 s dobrando (≈ 5,7 h) | resolve a conta impossível do plano anterior |
| TypeScript 7.0.2 com `erasableSyntaxOnly` | o Node só remove tipos: proíbe `enum`/`namespace` desde a primeira linha |
| Dependências fixadas: `pg` 8.23.1, `zod` 4.6.7; dev: `typescript` 7.0.2, `@types/node` 22.20.5, `@types/pg` 8.23.1 | `package-lock.json` versionado |
| Engine arredonda o consumo por pessoa uma única vez (racional exato) e corrige colunas movendo 1 centavo | arredondar por item favorecia o primeiro participante; correção garante total justo, colunas fechadas e nada negativo |
| Tokens de capacidade e chaves só resolvidos por função `SECURITY DEFINER` | a aplicação não consegue listar tokens nem chaves |
| Criação de pagamento com provedor em duas fases | o provedor é chamado fora da trava da conta (padrão exigido para PSP real) |
| Deduplicação de webhook por `(provider, event_id)` com rollback | duplicado não aplica nada, nem parcialmente |
| Consultas sequenciais por client | o `pg` 8.23 avisa que consultas paralelas no mesmo client serão removidas no pg 9 |
| Imagem `node:22.23.3-alpine3.24` (23/09/2026) | Node 22 recente, já estabilizado (a 22.23.4 saiu no próprio dia) |

### Arquivos criados

- Fundação: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml`, `Dockerfile`, `.dockerignore`, `docker-compose.yml`.
- Domínio puro: `src/modules/split/{money,engine}.ts`, `src/modules/ledger/chain.ts`, `src/modules/payments/state-machine.ts`, `src/modules/reconciliation/reconcile.ts`, `src/modules/policies/policy-engine.ts`.
- Infra: `src/config.ts`, `src/infra/clock.ts`, `src/infra/log.ts`, `src/infra/crypto/{canonical-json,hash,aead}.ts`, `src/infra/db/{pool,tx,migrate,role-check}.ts`, `src/infra/http/{router,server,rate-limit}.ts`.
- Serviços: `src/modules/expert/library.ts`, `src/modules/ledger/ledger-repo.ts`, `src/modules/reconciliation/service.ts`, `src/modules/shared-bills/{repo,service,view}.ts`, `src/modules/payments/{providers,service,webhooks}.ts`, `src/modules/service-context.ts`.
- Aplicação: `src/main.ts`, `src/app/{app,auth,guard,errors,deps,http-helpers,idempotency,worker}.ts`, `src/app/routes/{common,bills,payments}.ts`.
- Scripts: `scripts/db-init.sql`, `scripts/migrate.ts`, `scripts/create-tenant.ts`.
- Testes: `tests/unit/*.test.ts` (7 arquivos), `tests/integration/{helpers,http}.ts` e `{security-db,bills-flow,payments}.test.ts`.

### Arquivos alterados

`README.md`, `docs/01`, `docs/02` (D1–D17, regras do engine), `docs/03` (rotas implementadas, contrato de pagamento, D17, roadmap), este log.

### Migrations

- `0001_core.sql` — tenants, chaves, tokens, SharedBill, participantes, itens, atribuições, versões e alocações da divisão, pagamentos, roteamento de provedor, eventos de provedor, devoluções manuais, idempotência, ledger (trigger de encadeamento), audit_log; triggers de imutabilidade; RLS forçado por tenant e por conta (D9); funções de resolução de credencial; privilégios mínimos da aplicação.
- `0002_expert_library.sql` — `knowledge` com escopos, versões, vigência, quatro olhos no banco, conteúdo imutável; 9 regras fundadoras ACTIVE.
- `0003_payments_cbr.sql` — `cbr_cases` (resolvido é imutável), índice e função de expiração para o worker.

### Endpoints

24 das 44 rotas de `03` (lista com ✅ em `03 § Rotas`).

### UI

Nenhuma ainda (PWA é a fatia seguinte).

### Testes e comandos (executados nesta máquina)

Ambiente: Windows 10, Node v24.21.0, PostgreSQL 16.15 portátil (SCRAM-SHA-256), papéis `rachapay_owner`/`rachapay_app` sem superuser/BYPASSRLS.

```
npm run typecheck          → tsc 7.0.2 sem erros
npm run test:unit          → 70 testes, 70 pass, 0 fail
npm run test:integration   → 28 testes, 28 pass, 0 fail, 0 skipped
npm run check              → typecheck + unit + integration: verde
npm run migrate            → aplica 0001–0003; reexecução: "nada a aplicar"
npm run tenant:create      → tenant + chave rpk_ (mostrada uma vez)
node --env-file=.env src/main.ts → migrations na subida, /health 200, /ready 200,
  fluxo HTTP real: criar → item → prévia → confirmar → pagamento SANDBOX → webhook simulado
  → SETTLED; ledger com 9 entradas, cadeia válida, reconstrução consistente; stderr vazio;
  nenhum token no log
```

O que os testes provam (resumo):

- **Engine**: 100/3, 10,01/3, item por 7, pesos, serviço meio-para-cima sobre a base após desconto, desconto e gorjeta proporcionais, percentual e manual sobre o total final, validações, determinismo; propriedade com 3.500 cenários (colunas fecham, total por pessoa = maiores restos, nada negativo, afastamento máximo de componente 1,21 centavo).
- **Segurança no banco**: tenant A não lê, altera nem insere no B, nem por SQL direto; no tenant Pessoal uma conta não enxerga outra (D9); a aplicação não lê tokens nem chaves, não desliga RLS, não remove triggers, não cria tabela; ledger recusa UPDATE/DELETE/TRUNCATE até do dono; encadeamento errado é recusado; migration editada é recusada por checksum.
- **SharedBill via HTTP**: criação sem cadastro com serviço de 10% do restaurante; prévia; `STALE_PREVIEW`; confirmação; parte do organizador quitada (D5); travas depois de confirmar; complemento (D2); destravar; cancelar; convidado lê mas não edita (negação no audit_log); token de uma conta não abre outra; chave de API por tenant; chave `AI` barrada na confirmação; headers de segurança; envelope de erro; limite de criação anônima (D11).
- **Pagamentos via HTTP**: manual com confirmação do organizador (o convidado não confirma); recusa → caso; idempotência (D12) inclusive para erro de regra; **10 abas → 1 reserva** e 10 repetições da mesma chave → 1 pagamento; webhook assinado (assinatura errada, expirada e referência desconhecida recusadas; duplicado sem efeito); fora de ordem (adiado e reaplicado); expiração pelo worker; confirmação tardia; excedente vira `REFUND_DUE` + `OVERPAYMENT` sem cobrir a parte de outro; devolução manual (D3) resolve o caso; estorno e chargeback depois de quitada → `REOPENED` + casos; quitar de novo → `SETTLED`; reconstrução pelo ledger consistente em todos os fluxos.

### Falhas encontradas e corrigidas no ciclo

1. O teste de propriedade media o afastamento com o peso errado (total da pessoa em vez do consumo) — o engine estava certo; a medição foi corrigida.
2. `push` em array `readonly` na máquina de pagamento — pego pelo typecheck.
3. Consultas paralelas no mesmo client do `pg` (aviso de depreciação visto ao subir o app de verdade) — trocadas por sequenciais.

---

## Ciclo 0 — 20/10/2026 — arqueologia e base documental

**Objetivo:** validar o estado declarado pelos documentos canônicos e montar o repositório com uma base honesta antes de escrever código.

- Repositório `DevGomesLipe07/Racha-pay` criado vazio em 19/10/2026 (sem commits).
- Procurado o código descrito pela versão anterior deste log (`src/`, `migrations/`, `tests/`, `public/`, `pgwire.ts`, `0001_core.sql`) no GitHub e na máquina do proprietário: **não existia**. O proprietário confirmou que só os arquivos `.md` tinham sido criados.
- **Divergência material:** a versão anterior deste log declarava um "Ciclo 1" de 19/10/2026 como IMPLEMENTADO, com resultados de teste (28 unitários, 31 de integração, 1 E2E) sem código ou execução que os sustentassem. Reclassificado como escopo alvo; os resultados sem evidência foram removidos.
- O prompt mestre parte da premissa de que já existe implementação. A premissa não valia; o restante do prompt continua governando.
- Decisões: documentos como especificação com estado real; nenhuma regra alterada em silêncio; `pg` em vez de driver próprio; PostgreSQL 16.15 portátil (binários oficiais EDB) para testes locais, porque a máquina não tem Docker, WSL nem PostgreSQL.
- Falhas encontradas na análise (todas decididas depois, em `02`): retries de webhook impossíveis (D17); `SETTLED` sem considerar `NÃO ATRIBUÍDO` (D1); itens depois de pagamento parcial (D2); devolução de `REFUND_DUE` manual (D3); NexFlow sem mesa/comanda (decisão de domínio pendente).

---

## IMPLEMENTADO

- Racha Engine, dinheiro em centavos/BigInt, maiores restos.
- SharedBill completo pela API: criação (pessoal e Business), participantes, itens, atribuições com peso, modos, ajustes, prévia, confirmação, complemento (D2), destravar, cancelar.
- Multi-tenant com RLS forçado por tenant e por conta (D9); papéis owner/app (D16); credenciais só por hash.
- Ledger append-only encadeado por hash, imutável no banco, verificação e reconstrução (`GET /v1/bills/{id}/ledger`).
- Conciliação determinística e estados D6 recalculados a cada evento; parte do organizador (D5).
- Pagamentos MANUAL e SANDBOX: idempotência (D12), reserva concorrente, webhook assinado com anti-replay e deduplicação, eventos fora de ordem, confirmação tardia, estorno, chargeback, reabertura, excedente, devolução manual (D3), expiração pelo worker.
- Policy Engine com auditoria; IA barrada em toda ação financeira crítica.
- Expert Library: resolução por escopo/vigência, schema de conteúdo, 9 regras fundadoras usadas pelo engine e pelos pagamentos.
- Casos CBR automáticos para todas as exceções de pagamento.
- Operação: config validada (produção recusa segredos de dev, http e banco sem SSL), `/health`, `/ready`, `npm run migrate`, `npm run tenant:create`, logs JSON sem corpo/query/token.

## PARCIAL

- **Expert Library**: falta a API de governança (propor, revisar, aprovar com quatro olhos, ativar). O banco já garante conteúdo imutável e aprovador ≠ autor em regra crítica.
- **CBR**: casos criados e resolução de OVERPAYMENT via D3; faltam API de casos, similaridade (Jaccard) e propostas LEARNED.
- **Dockerfile / docker-compose / job `docker` do CI**: escritos, mas **não executados** — a máquina não tem Docker. O job do CI faz o build e checa `/ready`; resultado depende do primeiro push.
- **CI**: workflow escrito (unit em Node 22.18 e 24, integração com PostgreSQL 16, docker); ainda não rodou porque não houve push.
- **Rate limit**: em memória, por instância. Com várias instâncias, mover para PostgreSQL/Redis.

## BLOQUEADO

- **Pagamento real (Pix/cartão)** — falta escolher o PSP, contrato e credenciais. A interface `PaymentProvider` e o fluxo em duas fases já estão prontos para receber o adapter (`docs/03`).
- **Estorno via API de PSP** — depende do item acima (hoje: `501 REFUND_NOT_AVAILABLE` para provedor não implementado).
- **Adapter nativo do NexFlow** — falta decisão de encaixe de domínio (ver `docs/03`).
- **Homologação regulatória/LGPD** (base legal, política de privacidade, termos de uso) — decisão jurídica.

## PENDENTE

Restante do Ciclo 1, nesta ordem:

1. **Web/PWA** (organizador e convidado, QR, WhatsApp, selo RACHA QUITADO) + E2E no Chromium.
2. **Webhooks de saída**: outbox transacional, entrega assinada (segredo cifrado com AES-256-GCM, já implementado em `infra/crypto/aead.ts`), retentativa D17, `DEAD` e reprocessamento, proteção SSRF; rotas `webhook-endpoints` e `webhook-deliveries`.
3. **Estabelecimentos + ERP Gateway** (contrato canônico, idempotência por `externalReference`, complemento D2 por ERP, `ERP_DIVERGENCE`, ack).
4. **API de CBR e de governança da Expert Library**.
5. **Métricas North Star** (`GET /v1/metrics`) e **IA** (`AIProvider`, leitura de cupom por texto, explicação da conciliação).

Depois do Ciclo 1: rotina LGPD de anonimização/retenção; painel Business; contas opcionais; notificações; observabilidade externa e backup/restore testado; ML, RAG, MCP e agentes só com dados e necessidade comprovada.

## PARA O TI PUBLICAR

1. **Revisar e publicar**: o repositório local tem commits; nenhum push foi feito. `git push -u origin main` publica e dispara o CI.
2. **Banco**: PostgreSQL 16+. Como administrador: `psql -f scripts/db-init.sql` (troque as senhas). `DATABASE_URL` com `rachapay_app`; `MIGRATION_DATABASE_URL` com `rachapay_owner`.
3. **Ambiente**: `cp .env.example .env`; em produção defina `NODE_ENV=production`, `PUBLIC_BASE_URL=https://…`, `DATABASE_URL=…?sslmode=require`, `APP_ENCRYPTION_KEY` (`openssl rand -base64 32`), `ADMIN_TOKEN` (`openssl rand -hex 32`), `SANDBOX_WEBHOOK_SECRET`, `TRUST_PROXY=true` atrás de load balancer. Enquanto não houver PSP, o sandbox é o único meio além do manual.
4. **Migrations**: automáticas na subida quando `MIGRATION_DATABASE_URL` existe, ou `npm run migrate` no pipeline.
5. **Testes**: `TEST_DATABASE_URL` e `TEST_MIGRATION_DATABASE_URL` apontando para banco descartável → `npm run check`. **Nunca** contra produção (o teste recria o schema).
6. **Execução**: `npm start` (Node ≥ 22.18) ou `docker compose up --build`. Saúde: `/health`, `/ready`.
7. **Primeiro cliente Business**: `MIGRATION_DATABASE_URL=… npm run tenant:create -- --name "Restaurante X"` — a chave aparece uma vez.

## PRÓXIMO CICLO

Terminar o Ciclo 1 pela **Web/PWA + E2E** (é o que permite o piloto de 5–10 estabelecimentos responder à pergunta do Guia: *RachaPay é mais fácil do que "eu pago e vocês me fazem Pix"?*), seguida de webhooks de saída e ERP canônico. Em paralelo, fora do código: escolher o PSP (Pix + split de recebíveis) para destravar o E4 real.
