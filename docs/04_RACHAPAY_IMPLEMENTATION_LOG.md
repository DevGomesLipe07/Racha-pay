# 04 — Implementation Log

Registra só o que foi **efetivamente feito e provado**. Status permitidos: IMPLEMENTADO, PARCIAL, BLOQUEADO, PENDENTE.

---

## Ciclo 0 — 20/10/2026 — arqueologia e base documental

**Objetivo:** validar o estado declarado pelos documentos canônicos e montar o repositório com uma base honesta antes de escrever código.

### Arqueologia / validação

- Repositório `DevGomesLipe07/Racha-pay` criado vazio em 19/10/2026 (sem commits).
- Procurado o código descrito pela versão anterior deste log (`src/`, `migrations/`, `tests/`, `public/`, `pgwire.ts`, `0001_core.sql`) no GitHub e na máquina do proprietário: **não existe**. O proprietário confirmou que só os arquivos `.md` foram criados.
- **Divergência material (DOCUMENTAÇÃO DESATUALIZADA → na prática, antecipada):** a versão anterior deste log declarava um "Ciclo 1" de 19/10/2026 como IMPLEMENTADO, com resultados de teste (28 unitários, 31 de integração, 1 E2E) e falhas corrigidas. Nada disso tem código ou execução que o sustente. O conteúdo foi reclassificado abaixo como **escopo alvo do Ciclo 1**; os resultados de teste foram removidos por não terem evidência.
- O prompt mestre (`RACHAPAY_PROMPT_MESTRE_VSCODE_EVOLUCAO_CODIGO_REAL.md`) parte da premissa de que já existe implementação. A premissa não vale; o restante do prompt (provar antes de declarar, não inventar integração, código real e testado) continua governando.

### Decisões

| Decisão | Motivo |
|---|---|
| Documentos canônicos entram como **especificação**, com estado real em cada um | §U do prompt mestre: documentação nunca antecipa código como concluído |
| Regras de negócio e princípios não foram alterados; problemas viraram "pontos em aberto" | não mudar regra constitucional silenciosamente |
| Acesso ao PostgreSQL pelo pacote `pg`, não por driver próprio | o driver próprio do plano anterior só se justificava pela falta de npm no ambiente; aqui há npm, e driver de protocolo feito à mão é risco desnecessário num sistema financeiro |
| PostgreSQL 16.15 portátil (binários oficiais EDB) para testes locais | a máquina não tem Docker, WSL nem PostgreSQL instalado |

### Arquivos criados

`README.md`, `docs/01_RACHAPAY_CONSTITUICAO.md`, `docs/02_RACHAPAY_REGRAS_NEGOCIO.md`, `docs/03_RACHAPAY_ROADMAP_INTEGRACOES.md`, `docs/04_RACHAPAY_IMPLEMENTATION_LOG.md`, `RACHAPAY_PROMPT_MESTRE_VSCODE_EVOLUCAO_CODIGO_REAL.md`, `.gitattributes`.

Migrations, endpoints, UI e testes: nenhum.

### Ambiente verificado

- Windows 10, Node v24.21.0, npm 11.19.0, git 2.56, GitHub CLI 2.102.
- PostgreSQL 16.15 portátil em `%USERPROFILE%\tools\pg16`, cluster de teste em `%USERPROFILE%\tools\pgdata-rachapay` (SCRAM-SHA-256, só `localhost:5432`): inicializado, subiu, respondeu `select version()` e desligou sem erro.

### Falhas encontradas na análise dos documentos

1. Retries de webhook: "8 tentativas dobrando a partir de 10 s, até 6 h" é aritmeticamente impossível (máx. ~21 min) — a decidir (`03`).
2. `SETTLED` não considera o termo `NÃO ATRIBUÍDO` da conciliação — a decidir (`02`, ponto 1).
3. Sem regra para itens adicionados depois de pagamento parcial — a decidir (`02`, ponto 2).
4. Sem caminho de devolução de `REFUND_DUE` em pagamento manual — a decidir (`02`, ponto 3).
5. NexFlow: a especificação existe no vault VHAREN; o bloqueio real é de encaixe de domínio (sem mesa/comanda) — a decidir (`03`).

---

## IMPLEMENTADO

Nada.

## PARCIAL

Nada.

## BLOQUEADO

- **Pagamento real (Pix/cartão)** — falta escolher o PSP, contrato e credenciais. Passo a passo em `docs/03`.
- **Estorno via API de PSP** — depende do item acima.
- **Adapter nativo do NexFlow** — falta decisão de encaixe de domínio (ver `docs/03`).
- **Homologação regulatória/LGPD** (base legal, política de privacidade, termos de uso) — decisão jurídica.

## PENDENTE — escopo alvo do Ciclo 1

Primeiro vertical slice: abrir a Web/PWA → criar SharedBill → itens e participantes → divisão (igual, por item, compartilhada, serviço, arredondamento) → link sem instalar → convidado vê sua parte → pagamento sandbox/manual → conciliação → saldo zero → SETTLED → RACHA QUITADO → ledger com evidências → testes provando invariantes.

| Parte | Alvo | Prova exigida |
|---|---|---|
| Racha Engine | `src/modules/split/engine.ts` | unitários: 100/3, 10,01/3, item por 7, serviço, desconto, pesos, %, manual, determinismo; propriedade com 3.500 cenários |
| SharedBill | participantes, itens, atribuições, ajustes, prévia, confirmação com `STALE_PREVIEW`, destravar, cancelar | integração |
| Pagamentos | idempotência, concorrência (10 abas → 1 reserva), webhook assinado, anti-replay, duplicidade, fora de ordem, confirmação tardia, estorno, chargeback, expiração, manual com atestado do organizador | integração |
| Conciliação | determinística, quitação/reabertura, excedente por participante | unitários + integração |
| Ledger | append-only, cadeia de hash, triggers anti-UPDATE/DELETE/TRUNCATE, reconstrução | integração com detecção de adulteração |
| Multi-tenant | RLS forçado; recusa subir com papel que contorna RLS | integração: tenant A não lê/altera/insere no B nem via SQL |
| Expert Library / CEKE | escopos, versões, vigência, schema, quatro olhos, 9 regras fundadoras | integração |
| Policy Engine | auditoria; IA bloqueada em toda ação crítica | unitário |
| CBR | casos automáticos, resolução humana, Jaccard, propostas LEARNED em DRAFT | integração |
| ERP Gateway | contrato canônico, idempotência, divergência → 409 + caso, ack | integração |
| Webhooks de saída | HMAC, outbox transacional, retry, histórico, reprocessamento, SSRF | integração |
| IA | `AIProvider` + adapter Anthropic, parser de cupom em texto, explicação da conciliação | unitário contra servidor falso (PARCIAL até testar a API real) |
| Web/PWA | fluxo completo do organizador e do convidado, QR, WhatsApp, selo RACHA QUITADO, service worker, CSP estrita | E2E Chromium |
| Métricas | `GET /v1/metrics` (North Star) | integração |
| Operação | `.env.example`, `Dockerfile`, `docker-compose.yml`, `scripts/db-init.sql`, `npm run migrate`, `npm run tenant:create`, CI, `package-lock.json` | CI verde |

Decisões de arquitetura herdadas do plano anterior e mantidas: Node 22 + TypeScript nativo (sem build, `tsc` para typecheck); HTTP sobre `node:http`; tenant fixo "RachaPay Pessoal" para B2C; tokens no `#` da URL; pagamento V1 = MANUAL + SANDBOX; outbox + worker com `SKIP LOCKED` (sem Kafka/RabbitMQ); CBR relacional com Jaccard (sem vector DB); QR code vendorizado (Project Nayuki, MIT).

Depois do Ciclo 1: rotina LGPD de anonimização/retenção; painel Business; contas opcionais; notificações; observabilidade externa e backup/restore testado; ML, RAG, MCP e agentes só com dados e necessidade comprovada.

## PARA O TI PUBLICAR

Ainda não há o que publicar. Repositório local com commits de documentação; nenhum push feito.

## PRÓXIMO CICLO

**Ciclo 1 — núcleo financeiro primeiro:** Racha Engine + migrations com RLS + SharedBill + pagamento manual + conciliação + ledger + API, com testes unitários, de propriedade e de integração rodando contra o PostgreSQL local. PWA, ERP, webhooks, Expert Library completa e CBR nas etapas seguintes do mesmo ciclo.
