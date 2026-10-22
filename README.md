# RachaPay

**Pague a sua conta e de mais ninguém.**

Plataforma de divisão, cobrança, pagamento e conciliação de despesas compartilhadas. Projeto do Felipe, família VHAREN.

Monólito modular em TypeScript sobre Node.js 22, PostgreSQL como fonte da verdade, multi-tenant com RLS, API-first, ledger encadeado por hash, Expert Library versionada, memória de casos (CBR) e IA como apoio substituível — nunca como autoridade financeira.

> **Estado em 22/10/2026:** implementado e testado, com 160 testes (96 unitários, 61 de integração contra PostgreSQL real e 3 E2E no Chromium). O CI está verde no GitHub (build Docker, backup com restore verificado, CodeQL sem alertas). Isso cobre:
> - a API (documentada em `/openapi.json`) e a Web/PWA, com Pix do organizador por QR;
> - os painéis do estabelecimento e do administrador;
> - os pagamentos manual e sandbox e o ledger verificável;
> - os webhooks, o ERP canônico, a Expert Library e o CBR;
> - a IA como apoio, a LGPD, as métricas e o backup.
>
> Bloqueados por dependência externa: pagamento real via PSP, adapter nativo do NexFlow e hospedagem. Detalhes em `docs/04_RACHAPAY_IMPLEMENTATION_LOG.md`.

---

## Começar

Requisitos: **Node.js ≥ 22.18** (executa TypeScript nativamente, sem build) e **PostgreSQL ≥ 16**.

```bash
# 1. banco (uma vez, como administrador): dois papéis SEM superuser + bancos
psql -U postgres -f scripts/db-init.sql

# 2. ambiente
cp .env.example .env
#    acrescente MIGRATION_DATABASE_URL=postgresql://rachapay_owner:rachapay_owner_dev@localhost:5432/rachapay

# 3. dependências e testes
npm install
npm run check            # typecheck + unitários + integração

# 4. subir (aplica as migrations na subida quando MIGRATION_DATABASE_URL existe)
node --env-file=.env src/main.ts      # http://localhost:3000/health
```

Com Docker: `docker compose up --build` (validado no CI).

Backup: `BACKUP_DATABASE_URL=… npm run backup -- --out rachapay.dump` e `RESTORE_ADMIN_URL=… npm run backup:verify -- --dump rachapay.dump`.

E2E da interface (Chromium): `npx playwright install chromium && npm run test:e2e`.

**Papéis do banco (D16, D22):** `DATABASE_URL` usa `rachapay_app` (só DML); `MIGRATION_DATABASE_URL` usa `rachapay_owner` (dono do schema, só migrations); `BACKUP_DATABASE_URL` usa `rachapay_backup` (só leitura, só na rotina de backup). Em produção o servidor recusa subir se o papel da aplicação for superuser, BYPASSRLS ou dono das tabelas.

**Testes de integração:** `TEST_DATABASE_URL` (padrão `postgresql://rachapay_app:rachapay_dev@localhost:5432/rachapay_test`) e `TEST_MIGRATION_DATABASE_URL` (padrão com `rachapay_owner`). Eles **apagam e recriam o schema** — nunca aponte para produção.

**Windows sem Docker:** os binários oficiais do PostgreSQL 16 em zip (EnterpriseDB) rodam sem instalador: `initdb`, `pg_ctl start`, e depois o passo 1.

Primeiro cliente Business: `MIGRATION_DATABASE_URL=… npm run tenant:create -- --name "Restaurante X"` (a chave aparece uma vez).

---

## O que funciona hoje

| Fluxo | Estado |
|---|---|
| Criar racha sem conta e sem app (Web/PWA ou `POST /v1/bills`), link + QR + WhatsApp | ✅ |
| Itens, participantes, item compartilhado, pesos | ✅ |
| Divisão igual, por item, percentual, valores manuais (Racha Engine, centavos inteiros) | ✅ |
| Serviço, gorjeta, desconto, arredondamento vindos da Expert Library, com proveniência | ✅ |
| Prévia, confirmação, "mais uma rodada" (complemento), destravar, cancelar | ✅ |
| Convidado vê a própria parte e paga: Pix/dinheiro ao organizador (ele confirma) ou sandbox de teste | ✅ |
| Pix do organizador: QR e copia e cola com o valor exato da parte (BR Code, sem PSP e sem tarifa) | ✅ |
| Painel do administrador da plataforma (`/#/admin`): regras com quatro olhos, casos, métricas | ✅ |
| Conciliação e quitação determinísticas; parte do organizador já quitada; selo RACHA QUITADO | ✅ |
| Estorno, chargeback, reabertura, pagamento a maior, devolução manual | ✅ |
| Ledger encadeado e imutável, com reconstrução do estado | ✅ |
| Restaurante integrado (ERP canônico) e webhooks de saída assinados | ✅ |
| Expert Library com quatro olhos e CBR com aprendizado controlado | ✅ |
| Leitura de cupom: texto (sem IA) ✅ · foto (IA opcional) — testada só contra servidor falso | ✅ / ⚠️ |
| Métricas North Star | ✅ |
| Painel web do estabelecimento (`/#/b`): mesas, QR, caixa, casos, webhooks, conciliação do dia | ✅ |
| LGPD: retenção e anonimização; backup com restore verificado; métricas Prometheus | ✅ |
| Pagamento real via PSP | ⛔ bloqueado: falta contrato e credenciais de um PSP |
| Adapter nativo NexFlow | ⛔ bloqueado: decisão de encaixe de domínio |

## Estrutura

```
src/
  main.ts                 entrada (migrations, checagem do papel, servidor, worker)
  config.ts               configuração validada (produção recusa segredos de dev)
  app/                    rotas HTTP, autenticação, Policy Engine + audit, idempotência, worker
  infra/db/               pg, transações com escopo de tenant/conta, migrations, checagem de papel
  infra/http/             servidor, roteador, headers de segurança, rate limit
  infra/crypto/           SHA-256, HMAC, AES-GCM, JSON canônico
  modules/
    split/                Racha Engine (puro, sem I/O)
    shared-bills/         agregado SharedBill
    payments/             máquina de estados, provedores, webhooks de entrada
    reconciliation/       conciliação determinística e estados da conta
    ledger/               ledger append-only encadeado por hash
    expert/               Expert Library / CEKE e governança
    policies/             Policy Engine
    cbr/                  casos, similaridade e propostas de aprendizado
    ai/                   AIProvider + skills (o SDK da IA só existe aqui)
    integrations/erp/     ERP Gateway (contrato canônico)
    integrations/webhooks/ outbox, entrega assinada, SSRF
    analytics/            North Star e conciliação do dia
    privacy/              retenção e anonimização (LGPD)
public/                   Web/PWA (sem build, CSP estrita)
migrations/               SQL versionado (checksum protege contra edição)
scripts/                  db-init.sql, migrate, create-tenant, backup, verify-backup
tests/unit|integration|e2e|contract   (contract = kit que todo PSP precisa passar)
docs/                     constituição, regras, integrações, log de implementação
```

## Documentos

Leia nesta ordem — cada um é governado pelos anteriores:

1. `docs/01_RACHAPAY_CONSTITUICAO.md` — princípios inegociáveis e onde são garantidos no código
2. `docs/02_RACHAPAY_REGRAS_NEGOCIO.md` — regras de divisão, conciliação, estados e decisões D1–D23
3. `docs/03_RACHAPAY_ROADMAP_INTEGRACOES.md` — API, contrato ERP canônico, webhooks, PSP, roadmap
4. `docs/04_RACHAPAY_IMPLEMENTATION_LOG.md` — o que foi feito, provado e o que falta

Instrução de execução para agentes de código: `RACHAPAY_PROMPT_MESTRE_VSCODE_EVOLUCAO_CODIGO_REAL.md`.
