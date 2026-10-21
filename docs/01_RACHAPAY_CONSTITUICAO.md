# 01 — Constituição do RachaPay (aplicada ao código)

Resumo dos princípios do Guia Mestre e da Constituição de Inteligência, com o lugar onde cada um será garantido no código.

> **Estado em 21/10/2026:** os princípios abaixo são vigentes e inegociáveis. Onde a tabela diz **garantido**, existe código e teste executado (ver `04_RACHAPAY_IMPLEMENTATION_LOG.md`); onde diz **alvo**, ainda é especificação.
>
> Referências a "Guia Mestre §…" e "Constituição de Inteligência" apontam para documentos de visão que não estão neste repositório.

## A IA apoia. Ela não sustenta.

| Princípio | Onde |
|---|---|
| Fonte da verdade = PostgreSQL + ledger + regras + políticas + conhecimento aprovado | **garantido**: `src/modules/split/engine.ts`, `src/modules/reconciliation/reconcile.ts`, `src/modules/ledger/chain.ts` — nenhum importa IA |
| IA nunca executa ação financeira crítica | **garantido**: `src/modules/policies/policy-engine.ts`; teste unitário percorre todas as ações críticas com ator `AI` e escopo `*`; teste de integração: chave `AI` não confirma divisão (403) |
| Sistema funciona sem nenhum LLM | **garantido**: `NullAIProvider` é o padrão (`src/modules/ai/provider.ts`); toda a suíte (inclusive o E2E até RACHA QUITADO) roda com a IA desligada |
| LLM substituível, sem SDK no domínio | **garantido**: interface `AIProvider`; o SDK da Anthropic só existe em `src/modules/ai/anthropic-provider.ts` (D18) — nenhum módulo de domínio o importa |
| Saída de IA é sugestão confirmada por humano | **garantido**: `requiresConfirmation: true`; a rota de cupom não grava nada na conta (teste de integração confere); cada número vindo da IA é revalidado antes de ser mostrado |
| Falha da IA não derruba o núcleo | **garantido**: recusa, erro ou indisponibilidade viram `501/503` com código claro; a conta continua editável (teste de integração) |

## Ordem de maturidade da inteligência

| Camada | Estado | Observação |
|---|---|---|
| Dados e evidências | IMPLEMENTADO | ledger encadeado e imutável no banco, `provider_events`, `audit_log` |
| Regras determinísticas | IMPLEMENTADO | Racha Engine, conciliação, estados D6 |
| Policy Engine | IMPLEMENTADO | `POLICY_V1`; negadas e críticas auditadas |
| Expert Library / CEKE | IMPLEMENTADO | 9 regras fundadoras; escopos, versões, vigência, schema de conteúdo; DRAFT → REVIEW → APPROVED → ACTIVE (→ SUPERSEDED) com quatro olhos, máquina de estados e imutabilidade no banco; escopos compartilhados só pelo administrador |
| CBR + ledger | IMPLEMENTADO | casos automáticos de todas as exceções; similaridade (Jaccard, relacional); resolução humana; ≥ 3 casos iguais → proposta LEARNED em DRAFT; nada ativa sozinho |
| Machine Learning | PENDENTE | sem dados — não será criado por criar |
| RAG / RAG Enterprise | PENDENTE | sem corpus que justifique; filtro por tenant virá do RLS |
| MCP | PENDENTE | entra quando houver ferramentas estáveis expostas a agentes |
| Small LLM / LLM externo | PARCIAL | interface + adapter Anthropic (leitura de cupom por foto) testado contra servidor falso; **não testado contra a API real** (falta `ANTHROPIC_API_KEY`) |
| Fine-tuning | PENDENTE | só com baseline e métrica (Constituição §13) |
| Skills | IMPLEMENTADO | `ReceiptUnderstandingSkill` (texto determinístico; foto opcional), `ReconciliationExplanationSkill` (determinística, sem LLM), manifesto em `GET /v1/skills` |
| Agentes | PENDENTE | chaves de API com `actor_type = AI` já são bloqueadas pela Policy Engine em toda ação crítica (testado) |

## Dinheiro

- Sempre centavos inteiros (`bigint` no banco). Multiplicações internas em `BigInt`.
- Arredondamento: maiores restos com desempate pela posição do participante (`ROUNDING.ALLOCATION`).
- Invariantes verificadas em código antes de persistir e cobertas por testes de propriedade (3.500 cenários aleatórios por execução, semente fixa).

## Segurança

- Multi-tenant por **RLS forçado** (`FORCE ROW LEVEL SECURITY`), inclusive para o dono das tabelas. O servidor **recusa subir em produção** se o papel do banco for superuser/BYPASSRLS.
- Tokens guardados só como SHA-256; tokens de convite/organizador trafegam no fragmento da URL (não chegam ao servidor em logs nem em `Referer`).
- Webhooks de entrada: HMAC + janela de 5 min contra replay + deduplicação por `(provider, event_id)`.
- Webhooks de saída: HMAC, segredo cifrado (AES-256-GCM), retry exponencial (D17), bloqueio de destino privado em produção (SSRF) no cadastro e de novo na entrega (resolução DNS), sem seguir redirecionamento.
- Dois papéis no banco (D16): a aplicação não é dona das tabelas e não consegue desligar RLS nem remover triggers.
- CSP sem `unsafe-inline`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, HSTS com https.
- Logs sem corpo, sem query string, IDs mascarados.

## LGPD

- Participante é só um nome escolhido pelo usuário; sem CPF, telefone ou e-mail.
- IP não é armazenado. Métricas agregadas, sem dado pessoal.
- Pendente: rotina de anonimização/retenção (ver log).
- **Para decisão jurídica** (registrado, regra não alterada):
  - o nome do participante, mesmo livre, continua sendo dado pessoal quando identifica alguém;
  - enviar foto de cupom a um LLM externo é tratamento por terceiro e pode ser transferência internacional — exige base legal e menção na política de privacidade.

## Fora de escopo agora (Guia Mestre §29)

Outro ERP, adquirência própria, carteira custodial, cashback, pontos, rede social, marketplace, crédito, microserviços, blockchain, IA decidindo saldo.
