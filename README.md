# RachaPay

**Pague a sua conta e de mais ninguém.**

Plataforma de divisão, cobrança, pagamento e conciliação de despesas compartilhadas. Projeto do Felipe, família VHAREN.

Monólito modular em TypeScript sobre Node.js 22, PostgreSQL como fonte da verdade, multi-tenant com RLS, API-first, ledger encadeado por hash, Expert Library versionada, memória de casos (CBR) e IA como apoio substituível — nunca como autoridade financeira.

> **Estado em 20/10/2026: especificação, sem código.** Este repositório contém os documentos canônicos do RachaPay. O código do Ciclo 1 ainda não foi implementado — as seções abaixo descrevem o **alvo**. O que estiver de fato construído e testado fica registrado em `docs/04_RACHAPAY_IMPLEMENTATION_LOG.md`.

---

## Começar em 5 minutos (quando o Ciclo 1 for entregue)

Os comandos abaixo ainda não funcionam: `docker-compose.yml`, `package.json`, `scripts/` e `.env.example` ainda não existem.

### Opção A — Docker (recomendado para conhecer)

```bash
docker compose up --build
# abra http://localhost:3000
```

### Opção B — Node local

Requisitos: **Node.js ≥ 22.18** (executa TypeScript nativamente, sem build) e **PostgreSQL ≥ 16**.

```bash
# 1. banco: papel SEM superuser (obrigatório para o RLS valer) + bancos
psql -U postgres -f scripts/db-init.sql

# 2. ambiente
cp .env.example .env
#    preencha: DATABASE_URL, APP_ENCRYPTION_KEY (openssl rand -base64 32), SANDBOX_WEBHOOK_SECRET, ADMIN_TOKEN

# 3. dependências, migrations e testes
npm install
npm run migrate
npm run check            # typecheck + unitários + integração (usa TEST_DATABASE_URL)

# 4. subir
npm start                # http://localhost:3000
```

Variável dos testes: `TEST_DATABASE_URL` (padrão: `postgresql://rachapay_app:rachapay_dev@localhost:5432/rachapay_test`). Os testes de integração **apagam e recriam o schema** desse banco — nunca aponte para produção.

E2E de interface (Chromium): `npx playwright install chromium && npm run test:e2e`.

---

## O que o Ciclo 1 deve entregar

| Fluxo | Como |
|---|---|
| Criar racha sem conta e sem app | Web/PWA, `POST /v1/bills` |
| Itens, participantes, item compartilhado, pesos | organizador (link privado) |
| Divisão igual, por item, percentual, valores manuais | Racha Engine determinístico, centavos inteiros |
| Serviço, gorjeta, desconto, arredondamento | regras vindas da Expert Library, com proveniência no ledger |
| Link + QR + WhatsApp para convidados | token no fragmento `#` da URL |
| Convidado vê a própria parte e paga | Pix/dinheiro ao organizador (confirmação dele) ou sandbox de teste |
| Conciliação e quitação | invariante verificada a cada evento; SETTLED só por regra determinística |
| Estorno, chargeback, reabertura, pagamento a maior | eventos compensatórios, casos CBR |
| Restaurante integrado (ERP) | contrato canônico `POST /v1/integrations/erp/generic/sync` + webhooks assinados |
| Leitura de cupom | texto: parser determinístico; foto: IA opcional (Anthropic), sempre como sugestão |

## Status honesto

**Nada implementado ainda.** O acompanhamento real fica em `docs/04_RACHAPAY_IMPLEMENTATION_LOG.md`. Além do Ciclo 1 em si, estes itens já se sabem **bloqueados** por dependência externa:

- **Pagamento real (Pix/cartão via PSP): BLOQUEADO** — depende de contrato e credenciais de um PSP. O adapter será uma interface (`PaymentProvider`); o sandbox é só teste.
- **Adapter nativo NexFlow: BLOQUEADO** — depende de decisão de encaixe de domínio (ver `docs/03`). O NexFlow poderá integrar enviando o contrato canônico.
- **Leitura de cupom por foto**: só poderá ser validada contra a API real com `ANTHROPIC_API_KEY`.

## Estrutura (alvo)

```
src/
  main.ts                 entrada (migrations, checagem de RLS, servidor, worker)
  config.ts               configuração validada (produção recusa segredos de dev)
  app/                    rotas HTTP, contexto, worker de jobs
  infra/db/               acesso ao PostgreSQL (pacote `pg`), transações por tenant, migrations
  infra/http/             servidor HTTP, segurança, rate limit, estáticos
  infra/crypto/           hashes, HMAC, AES-GCM, JSON canônico
  modules/
    split/                Racha Engine (puro, sem I/O)
    shared-bills/         agregado SharedBill (participantes, itens)
    payments/             provedores, máquina de estados, idempotência
    reconciliation/       conciliação determinística e quitação
    ledger/               ledger append-only encadeado por hash
    expert/               Expert Library / CEKE
    policies/             Policy Engine
    cbr/                  memória de casos e propostas de aprendizado
    ai/                   AIProvider + skills
    integrations/erp/     ERP Gateway (contrato canônico)
    integrations/webhooks/ outbox transacional e entrega assinada
    identity/ audit/ analytics/
migrations/               SQL versionado (checksum protege contra edição)
public/                   Web/PWA (sem build)
tests/unit|integration|e2e
docs/                     constituição, regras, integrações, log de implementação
```

## Documentos

Leia nesta ordem — cada um é governado pelos anteriores:

1. `docs/01_RACHAPAY_CONSTITUICAO.md` — princípios inegociáveis e onde serão garantidos no código
2. `docs/02_RACHAPAY_REGRAS_NEGOCIO.md` — regras de divisão, conciliação, estados
3. `docs/03_RACHAPAY_ROADMAP_INTEGRACOES.md` — API, contrato ERP canônico, webhooks, PSP, roadmap
4. `docs/04_RACHAPAY_IMPLEMENTATION_LOG.md` — o que foi feito, provado e o que falta

Instrução de execução para agentes de código: `RACHAPAY_PROMPT_MESTRE_VSCODE_EVOLUCAO_CODIGO_REAL.md`.
