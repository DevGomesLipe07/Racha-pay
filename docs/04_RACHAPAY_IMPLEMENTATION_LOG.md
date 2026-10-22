# 04 — Implementation Log

Registra só o que foi **efetivamente feito e provado**. Status permitidos: IMPLEMENTADO, PARCIAL, BLOQUEADO, PENDENTE.

---

## Ciclo 3 — 22/10/2026 — tudo o que não depende de terceiros

**Objetivo:** pedido do proprietário: "prossiga com tudo o que não depende de terceiros". Ordem por valor.

| Entrega | Prova |
|---|---|
| **Pix do organizador (D23):** QR + copia e cola com o valor da parte, sem PSP e sem tarifa; chave validada (CPF/CNPJ com dígito, telefone, e-mail, aleatória), mascarada, apagada na anonimização | gerador reproduz **o exemplo oficial do Banco Central** byte a byte (CRC `1D3D`); integração (valor exato, valor restante depois de pagamento parcial, permissões, anonimização); E2E com o QR na tela do convidado |
| **Painel do administrador da plataforma** (`#/admin`): regras compartilhadas (propor, revisar, aprovar, ativar, revogar), casos do tenant Pessoal, métricas | E2E: a autora é barrada ao aprovar a própria regra crítica, outra pessoa aprova e ativa, a API passa a resolver a regra nova; caso resolvido pela tela |
| **Kit de contrato para PSP** (`tests/contract/payment-provider.contract.ts`) | sandbox passa nos 5 testes; um adapter real (ex.: Asaas) só precisa das fixtures dele |
| **OpenAPI 3.1** em `/openapi.json`, gerado dos schemas Zod | teste: rotas documentadas = rotas registradas |
| **Expiração de regras:** conhecimento com `valid_to` vencido passa a `EXPIRED` na rotina horária (a resolução já o ignorava) | integração: volta a valer a regra global e o status muda |
| **Cadeia de dependências:** Dependabot com cooldown de 14 dias e sem major do runtime; `npm audit` de produção no CI; CodeQL `security-extended` | CodeQL apontou 3 alertas → corrigidos → **0 abertos**; `npm audit`: 0 vulnerabilidades |

Falhas encontradas e corrigidas:

1. **CodeQL:**
   - o cliente montava a URL da API com o id vindo do link (um link malicioso poderia apontar outra rota); agora id e token do link são validados e o cliente só chama `/v1/…` sem `..`;
   - leitura de arquivo estático com corrida entre "checar" e "ler";
   - teste de script inline sensível a maiúsculas.
2. **O relatório do dia usava a data do aparelho;** agora usa a do servidor (achado pelo E2E quando o dia virou).
3. **CI:** o runner passou a trazer um `pg_dump` mais novo, que grava `transaction_timeout` e quebra a restauração no PostgreSQL 16. Agora o CI usa `pg_dump`/`pg_restore` da própria imagem `postgres:16`, e a documentação do backup avisa para usar a mesma versão do servidor.
4. **Testes que estavam errados:**
   - o exemplo do Banco Central mantém maiúsculas e minúsculas no nome;
   - o campo de valor não tem zero à esquerda.

Migration nova: `0009_organizer_pix.sql`.

```
npm run test:unit        → 96 testes, 96 pass
npm run test:integration → 61 testes, 61 pass
npm run test:e2e         → 3 testes, 3 pass (pessoal com Pix, painel Business, painel admin)
GitHub Actions (main)    → ci: success (unit ×2, integration+E2E+backup, docker) · codeql: success, 0 alertas
```

---

## Ciclo 2 — 21/10/2026 — publicação e pendências de maior valor

**Objetivo:** fazer o que antes estava "para o TI" e fechar as maiores pendências, na ordem de impacto (pedido do proprietário: "faça tudo o que você pode, priorizando as maiores pendências").

| Fatia | Entrega | Prova |
|---|---|---|
| Publicação | push para `DevGomesLipe07/Racha-pay` (público, como o proprietário criou) | CI verde em todos os pushes: unit (Node 22.18 e 24), integração + E2E com PostgreSQL 16, **build Docker + `docker compose up` + `/ready`** (antes PARCIAL) |
| Painel web Business | `#/b`: login de operador, mesas abertas, abrir mesa + QR, gestão da conta (mesma tela do organizador), confirmação no caixa, casos, entregas de webhook, conciliação do dia; API `GET /v1/bills`, `GET /v1/reports/daily`, `establishmentId` na criação | integração (lista, filtros, isolamento, relatório) + E2E Chromium do painel inteiro |
| Regra por estabelecimento | resolução da Expert Library passa a considerar estabelecimento e ERP da conta | integração: serviço de 13% só nas mesas do estabelecimento com a regra |
| LGPD (D21) | retenção/anonimização horária por tenant, pedido do titular, links revogados, idempotência vencida apagada, botão na interface | integração: ledger idêntico e verificável depois de anonimizar; prazos; recusas |
| Observabilidade | `/metrics` Prometheus (requisições, latência, worker, pool), protegido por `ADMIN_TOKEN`, sem ids nos rótulos | unidade + integração |
| Backup (D22) | papel `rachapay_backup`; `npm run backup` / `backup:verify` (restaura num banco descartável e compara tabelas, cabeças e cadeias do ledger) | executado aqui e **no CI**; reprova dump truncado e origem alterada; sem senha em argumento ou mensagem de erro |
| Rate limit (D11) | compartilhado no PostgreSQL entre instâncias; sal derivado da `APP_ENCRYPTION_KEY` | integração com duas instâncias somando o limite; IP não armazenado |
| CBR do tenant Pessoal | administrador da plataforma lista e resolve com `tenantId`, auditado | integração |

Migrations novas: `0007_retention.sql`, `0008_rate_limit.sql`.

```
npm run typecheck   → sem erros
npm run test:unit   → 84 testes, 84 pass
npm run test:integration → 58 testes, 58 pass, 0 skipped
npm run test:e2e    → 2 testes, 2 pass (PWA pessoal + painel Business)
npm run backup + backup:verify → ok (25 tabelas, 7–8 migrations, cadeias íntegras); negativos reprovados
GitHub Actions      → success em todos os jobs (unit ×2, integration+E2E+backup, docker)
```

Falhas encontradas e corrigidas: (1) a tela da mesa não tinha as abas do painel (achado pelo E2E); (2) `pg_restore` com senha na linha de comando e na mensagem de erro — senha agora só no ambiente do processo filho; (3) `pg_restore` recusa `--dbname` depois do arquivo; (4) propriedade declarada no construtor barrada pelo `erasableSyntaxOnly` (a proteção funcionou).

---

## Ciclo 1 — 21/10/2026 — monólito completo do escopo do Ciclo 1 (fatias S1–S10)

**Objetivo:** construir de verdade o escopo alvo do Ciclo 1 — do domínio financeiro à interface —, provado por testes contra PostgreSQL real e navegador real, na ordem decidida pelo proprietário (núcleo primeiro; "sempre siga com as melhores decisões").

### Arqueologia / validação

Repositório só com documentação (Ciclo 0). As lacunas do Ciclo 0 foram decididas pelo proprietário (D1–D15); D16–D20 surgiram durante a implementação. Todas em `02 § Decisões`.

### Fatias

| Fatia | Entrega |
|---|---|
| S1 | Fundação + domínio puro: Racha Engine, ledger encadeado, máquina de pagamento, conciliação e estados D6, Policy Engine, config, cripto, CI |
| S2 | Banco: schema com RLS forçado por tenant e por conta (D9), papéis owner/app (D16), ledger imutável no banco, migrations com checksum |
| S3 | SharedBill pela API + Expert Library (9 regras) + auth (4 credenciais) + audit + HTTP seguro + rate limit (D11) |
| S4 | Pagamentos MANUAL e SANDBOX: idempotência (D12), reserva concorrente, webhook assinado, fora de ordem, confirmação tardia, estorno, chargeback, REOPENED, devolução manual (D3), expiração, casos CBR |
| S5 | Operação: `npm run migrate`, `npm run tenant:create`, Dockerfile, compose, CI |
| S6 | Web/PWA sem build + E2E Chromium (3 celulares) |
| S7 | Webhooks de saída: outbox transacional alimentado pelo ledger, entrega assinada, D17, SSRF |
| S8 | Estabelecimentos + ERP Gateway canônico (sync, complemento D2 pelo ERP, ERP_DIVERGENCE, ack); NexFlow 501 |
| S9 | Governança da Expert Library (quatro olhos, máquina de estados no banco, escopos compartilhados pelo admin) + API de CBR (Jaccard, propostas LEARNED) |
| S10 | IA como apoio (AIProvider, leitura de cupom texto/foto, explicação determinística, skills) + métricas North Star |

### Decisões de implementação

| Decisão | Motivo |
|---|---|
| D16: papéis `rachapay_owner` (migrations) e `rachapay_app` (aplicação) | com um papel só, a aplicação poderia desligar RLS ou apagar triggers do ledger |
| D17: webhooks com 12 tentativas, 10 s dobrando (≈ 5,7 h) | resolve a conta impossível do plano anterior |
| D18: SDK oficial da Anthropic só no adapter de IA | o "HTTP puro" só existia por falta de npm; o SDK fica fora do domínio, atrás de `AIProvider` |
| D19: volume da North Star separado (declarado / teste / provedor) | pagamento manual não é dinheiro visto pelo RachaPay; sandbox não é dinheiro |
| D20: novo link de convidado | token só existe em hash; o organizador em outro aparelho precisa poder gerar outro |
| TypeScript 7.0.2 com `erasableSyntaxOnly` | o Node só remove tipos: proíbe `enum`/`namespace` desde a primeira linha |
| Dependências fixadas: `pg` 8.23.1, `zod` 4.6.7, `@anthropic-ai/sdk` 0.133.0; dev: `typescript` 7.0.2, `@types/node` 22.20.5, `@types/pg` 8.23.1, `playwright` 1.63.0, `qrcode-generator` 2.0.4 | `package-lock.json` versionado; versões com pelo menos ~2 semanas (a 1.0.0 do SDK saiu no próprio dia e foi evitada) |
| Engine arredonda o consumo por pessoa uma única vez (racional exato) e corrige colunas movendo 1 centavo | arredondar por item favorecia o primeiro participante; a correção garante total justo, colunas fechadas e nada negativo |
| Tokens e chaves só resolvidos por função `SECURITY DEFINER` | a aplicação não consegue listar tokens nem chaves |
| Pagamento com provedor em duas fases | o provedor é chamado fora da trava da conta (padrão exigido para PSP real) |
| Deduplicação de webhook por `(provider, event_id)` com rollback | duplicado não aplica nada, nem parcialmente |
| Outbox gravado dentro de `appendLedger` | não existe lançamento financeiro sem o aviso correspondente, nem aviso sem lançamento |
| Tabelas operacionais do worker (outbox, entregas, índice de expiração) com RLS sem FORCE | o worker descobre trabalho por função do dono; a aplicação continua presa ao escopo; a verdade financeira segue com FORCE |
| Escopos compartilhados da Expert Library: marca `app.platform_admin` na sessão, posta só depois do `ADMIN_TOKEN` | o banco exige a marca; a garantia de quem pode pô-la é da aplicação (documentado) |
| QR code gerado no navegador (`qrcode-generator`, MIT, vendorizado) | sem CDN, compatível com CSP `script-src 'self'` |
| Imagem `node:22.23.3-alpine3.24` (23/09/2026) | Node 22 recente, já estabilizado |

### Migrations

- `0001_core.sql` — tenants, chaves, tokens, SharedBill, participantes, itens, atribuições, versões e alocações da divisão, pagamentos, roteamento de provedor, eventos de provedor, devoluções manuais, idempotência, ledger (trigger de encadeamento), audit_log; imutabilidade; RLS forçado por tenant e por conta; funções de resolução de credencial; privilégios mínimos.
- `0002_expert_library.sql` — `knowledge` com escopos, versões, vigência, quatro olhos no banco, conteúdo imutável; 9 regras fundadoras ACTIVE.
- `0003_payments_cbr.sql` — `cbr_cases` (resolvido é imutável), índice e função de expiração.
- `0004_webhooks_outbox.sql` — endpoints, outbox, entregas, descoberta de trabalho do worker.
- `0005_establishments_erp.sql` — estabelecimentos; vínculo da conta com estabelecimento e ERP.
- `0006_knowledge_governance.sql` — máquina de estados do conhecimento no banco, uma ACTIVE por chave/escopo, escrita de escopos compartilhados só com marca de admin.

### Endpoints e UI

As 44 rotas de `03` mais `POST /v1/bills/{id}/share-links` (D20). Web/PWA em `/`: criar racha, participantes, itens com quem consumiu, modos de divisão, ajustes, prévia, confirmação, QR + WhatsApp + copiar link, novo link de convidado, pagamentos a confirmar ("Recebi" / "Não recebi"), devolução de excedente, "mais uma rodada", tela do convidado (escolher quem é, ver a própria parte, avisar pagamento manual ou pagar no sandbox), selo RACHA QUITADO, evidência do ledger, service worker, manifesto, tema claro/escuro.

### Testes e comandos (executados nesta máquina)

Ambiente: Windows 10, Node v24.21.0, PostgreSQL 16.15 portátil (SCRAM-SHA-256), papéis `rachapay_owner`/`rachapay_app` sem superuser/BYPASSRLS, Chromium do Playwright 1.63.

```
npm run typecheck          → tsc 7.0.2 sem erros
npm run test:unit          → 82 testes, 82 pass, 0 fail
npm run test:integration   → 48 testes, 48 pass, 0 fail, 0 skipped
npm run test:e2e           → 1 teste, 1 pass (3 celulares, sem erro de console nem violação de CSP)
npm run check              → typecheck + unit + integration: verde
npm run migrate            → aplica 0001–0006; reexecução: "nada a aplicar"
npm run tenant:create      → tenant + chave rpk_ (mostrada uma vez)
node --env-file=.env src/main.ts → migrations 0004–0006 aplicadas na subida, /ready 200, PWA 200,
  fluxo HTTP real (criar → item → confirmar → pagamento sandbox → webhook → SETTLED; ledger com
  9 entradas, cadeia válida, reconstrução consistente); stderr vazio; nenhum token no log
```

O que os testes provam (resumo):

- **Engine**: casos documentados (100/3, 10,01/3, item por 7, pesos, serviço meio-para-cima, desconto e gorjeta proporcionais, percentual e manual sobre o total final) e propriedade com 3.500 cenários (colunas fecham, total por pessoa = maiores restos, nada negativo, afastamento máximo de componente 1,21 centavo).
- **Segurança no banco**: isolamento entre tenants e entre contas do tenant Pessoal (D9), inclusive por SQL direto; a aplicação não lê tokens nem chaves, não desliga RLS, não remove triggers; ledger e conhecimento recusam alteração até do dono; migration editada é recusada.
- **Conta pela API**: criação, prévia, `STALE_PREVIEW`, confirmação, parte do organizador (D5), travas, complemento (D2), destravar, cancelar, novo link (D20), permissões por credencial, IA barrada, headers de segurança, rate limit (D11), servidor estático sem *path traversal*.
- **Pagamentos**: manual com confirmação humana, recusa, idempotência (D12), **10 abas → 1 reserva**, webhook assinado (errado/expirado/desconhecido recusados; duplicado sem efeito), fora de ordem, expiração, confirmação tardia, excedente por participante, devolução manual (D3), estorno e chargeback → REOPENED → SETTLED; reconstrução pelo ledger consistente em todos os fluxos.
- **Webhooks**: eventos assinados na ordem do fluxo, segredo cifrado, D17 até DEAD, reprocessamento, SSRF (unidade), tenant Pessoal sem outbox.
- **ERP**: CREATED/UNCHANGED/UPDATED, complemento automático, ERP_DIVERGENCE com caso, ack no ledger, NexFlow 501, permissões.
- **Expert Library / CBR**: schema, quatro olhos, IA e SYSTEM não aprovam, ativação muda o serviço cobrado nas contas novas e aposenta a versão anterior, admin governa escopo compartilhado; casos → Jaccard → decisão humana → proposta LEARNED em DRAFT.
- **IA e métricas**: parser de cupom; adapter Anthropic contra servidor falso (headers, beta de fallback, `output_config.format`, imagem, revalidação dos números, recusa e erro viram 503 sem afetar a conta); explicação determinística; North Star com conclusão, mediana, volume separado (D19) e exceções.

### Falhas encontradas e corrigidas no ciclo

1. Teste de propriedade media o afastamento com o peso errado — o engine estava certo; a medição foi corrigida.
2. `push` em array `readonly` — pego pelo typecheck.
3. Consultas paralelas no mesmo client do `pg` (aviso visto ao subir o app de verdade) — trocadas por sequenciais.
4. PWA: reabrir a tela do organizador apagava do aparelho o link de convidado — histórico agora é mesclado (achado pelo E2E).
5. PWA: a primeira rodada da atualização automática não redesenhava, e um pagamento chegado antes dela nunca aparecia — assinatura inicial passou a ser a do estado desenhado (achado pelo E2E).
6. `SELECT … FOR UPDATE` obedece às políticas de UPDATE do RLS e escondia (404) conhecimento de outro nível — leitura sem trava antes, para responder 403 com o motivo.
7. Rotas de conhecimento validavam o corpo antes da credencial (credencial inválida recebia 422) — autenticação passou a vir primeiro.
8. Testes que estavam errados (a regra estava certa): confirmação manual com chave `SYSTEM` (exige humano) e justificativa curta demais.

---

## Ciclo 0 — 20/10/2026 — arqueologia e base documental

- Repositório `DevGomesLipe07/Racha-pay` criado vazio em 19/10/2026 (sem commits).
- O código descrito pela versão anterior deste log **não existia**; o proprietário confirmou que só os arquivos `.md` tinham sido criados. O "Ciclo 1" antes declarado (com 28/31/1 testes) não tinha código nem execução que o sustentasse: reclassificado como escopo alvo e reconstruído de verdade no Ciclo 1 acima.
- Decisões: documentos como especificação com estado real; nenhuma regra alterada em silêncio; `pg` em vez de driver próprio; PostgreSQL 16.15 portátil para testes locais (a máquina não tem Docker, WSL nem PostgreSQL).
- Falhas encontradas na análise, todas decididas depois (`02`): retries impossíveis (D17), `SETTLED` sem `NÃO ATRIBUÍDO` (D1), itens depois de pagamento parcial (D2), devolução manual (D3), NexFlow sem mesa/comanda (decisão de domínio pendente).

---

## IMPLEMENTADO

- Racha Engine, dinheiro em centavos/BigInt, maiores restos.
- SharedBill completo: criação (pessoal e Business), participantes, itens, atribuições com peso, 4 modos, ajustes, prévia, confirmação, complemento (D2), destravar, cancelar, novo link (D20).
- Multi-tenant com RLS forçado por tenant e por conta (D9); papéis owner/app (D16); credenciais só por hash.
- Ledger append-only encadeado por hash, imutável no banco, verificação e reconstrução.
- Conciliação determinística e estados D6 a cada evento; parte do organizador (D5).
- Pagamentos MANUAL e SANDBOX com todas as regras de `02 § Pagamentos`, devolução manual (D3) e expiração.
- Policy Engine com auditoria; IA barrada em toda ação financeira crítica; ações humanas exigem chave `HUMAN`.
- Expert Library com governança completa e CBR com aprendizado controlado.
- Webhooks de saída (outbox, assinatura, D17, SSRF) e ERP Gateway canônico.
- Web/PWA (organizador e convidado, com **Pix do organizador por QR/copia e cola**), **painel web Business** (`#/b`) e **painel do administrador** (`#/admin`).
- OpenAPI 3.1 em `/openapi.json`; kit de contrato para PSP; Dependabot, `npm audit` e CodeQL no GitHub.
- IA como apoio: leitura de cupom por texto (determinística), explicação da conciliação, manifesto de skills; IA desligada por padrão.
- Métricas North Star e conciliação do dia por estabelecimento.
- LGPD: retenção e anonimização (D21), pedido do titular.
- Operação: config validada (produção recusa segredos de dev, http e banco sem SSL), `/health`, `/ready`, `/metrics` (Prometheus), `npm run migrate`, `npm run tenant:create`, backup com restore verificado (D22), rate limit compartilhado entre instâncias, logs JSON sem corpo/query/token, worker interno.
- Publicação: código no GitHub; CI verde (unit em Node 22.18 e 24, integração, 2 E2E, backup verificado, build Docker + compose + `/ready`).

## PARCIAL

- **Leitura de cupom por foto (IA)**: adapter pronto e testado contra servidor falso; **não testado contra a API real da Anthropic** (falta `ANTHROPIC_API_KEY` neste ambiente). Modelo padrão `claude-sonnet-5-5`.
- **Escopos compartilhados da Expert Library**: o banco exige a marca de administrador na sessão, mas quem põe a marca é a aplicação (depois de validar o `ADMIN_TOKEN`) — defesa em profundidade menor que a do resto do RLS.
- **Retenção (D21)** passa por todos os tenants a cada hora — adequado para centenas de tenants; para dezenas de milhares, paginar por tenant.

## BLOQUEADO

- **Pagamento real (Pix/cartão)** — falta escolher o PSP, contrato e credenciais. A interface `PaymentProvider` e o fluxo em duas fases estão prontos (`docs/03`).
- **Estorno via API de PSP** — depende do item acima (hoje: `501 REFUND_NOT_AVAILABLE`).
- **Adapter nativo do NexFlow** — falta decidir o encaixe de domínio (ver `docs/03`); `/v1/integrations/erp/nexflow/*` responde 501.
- **Homologação regulatória/LGPD** (base legal, política de privacidade, termos de uso; envio de foto a LLM externo) — decisão jurídica.

## PENDENTE

1. **Ambiente de produção**: provedor de hospedagem e PostgreSQL gerenciado, domínio com https, segredos — exige conta e decisão do proprietário (custo).
2. Contas de usuário opcionais e notificações (WhatsApp/push), se o piloto pedir.
3. ML, RAG, MCP e agentes: só com dados e necessidade comprovada.

## PARA O TI PUBLICAR

O que dependia só de código já foi feito e provado no CI. O que sobra exige conta, dinheiro ou decisão:

1. **Escolher onde hospedar** (qualquer plataforma com Node 22.18+ ou contêiner: Render, Railway, Fly.io, Cloud Run, ECS) e um **PostgreSQL 16+ gerenciado** (Neon, Supabase, RDS).
2. **Banco**: como administrador, `psql -f scripts/db-init.sql` **trocando as três senhas** (`rachapay_owner`, `rachapay_app`, `rachapay_backup`). `DATABASE_URL` com `rachapay_app`; `MIGRATION_DATABASE_URL` com `rachapay_owner`; `BACKUP_DATABASE_URL` com `rachapay_backup` (só na rotina de backup). Se o provedor não deixar criar papel com BYPASSRLS, use o snapshot do próprio provedor e rode `backup:verify` num restore dele.
3. **Segredos** (no cofre da plataforma): `NODE_ENV=production`, `PUBLIC_BASE_URL=https://…`, `DATABASE_URL=…?sslmode=require`, `APP_ENCRYPTION_KEY` (`openssl rand -base64 32`), `ADMIN_TOKEN` (`openssl rand -hex 32`), `SANDBOX_WEBHOOK_SECRET`, `TRUST_PROXY=true` atrás de load balancer. O servidor recusa subir com valores de desenvolvimento.
4. **Deploy**: imagem do `Dockerfile` (já validada no CI) ou `npm start`. Saúde: `/health`, `/ready`; métricas: `/metrics` com `Authorization: Bearer <ADMIN_TOKEN>`.
5. **Backup diário**: `npm run backup -- --out …` agendado + `npm run backup:verify` semanal num servidor de restauração.
6. **Primeiro cliente Business**: `MIGRATION_DATABASE_URL=… npm run tenant:create -- --name "Restaurante X" --actor-type HUMAN` — a chave aparece uma vez; o operador entra em `https://…/#/b`.
7. **Homologar a IA** (só se for usar foto de cupom): `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` e um cupom de teste.

## PRÓXIMO CICLO

**Piloto com 5–10 estabelecimentos** (fluxo manual + organizador e painel Business, que já existem) para responder à pergunta do Guia: *RachaPay é mais fácil do que "eu pago e vocês me fazem Pix"?* Fora do código: escolher hospedagem e PSP (Pix + split de recebíveis) e decidir o encaixe do NexFlow.
