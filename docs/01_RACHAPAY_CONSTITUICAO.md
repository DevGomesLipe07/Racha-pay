# 01 — Constituição do RachaPay (aplicada ao código)

Resumo dos princípios do Guia Mestre e da Constituição de Inteligência, com o lugar onde cada um será garantido no código.

> **Estado em 20/10/2026:** os princípios abaixo são vigentes e inegociáveis. O código que os garante **ainda não existe**. A coluna "Onde será garantido" é o alvo; vira "garantido" — com o caminho real e o teste — à medida que cada parte for implementada e provada (ver `04_RACHAPAY_IMPLEMENTATION_LOG.md`).
>
> Referências a "Guia Mestre §…" e "Constituição de Inteligência" apontam para documentos de visão que não estão neste repositório.

## A IA apoia. Ela não sustenta.

| Princípio | Onde será garantido |
|---|---|
| Fonte da verdade = PostgreSQL + ledger + regras + políticas + conhecimento aprovado | `modules/split/engine.ts`, `modules/reconciliation/reconcile.ts`, `modules/ledger/ledger.ts` — nenhum importa IA |
| Sistema funciona sem nenhum LLM | `NullAIProvider` como padrão; teste `IA: sem provedor…` quita um racha com IA desligada |
| IA nunca executa ação financeira crítica | `policies/policy-engine.ts` (`FINANCIAL_CRITICAL`); teste unitário percorre todas as ações com ator `AI` e escopo `*` |
| LLM substituível, sem SDK no domínio | `modules/ai/provider.ts` (interface `AIProvider`, adapter HTTP puro) |
| Saída de IA é sugestão confirmada por humano | `modules/ai/skills.ts` (`requiresConfirmation: true`; nada é gravado na conta) |

## Ordem de maturidade da inteligência

| Camada | Estado | Alvo / observação |
|---|---|---|
| Dados e evidências | PENDENTE | ledger encadeado, `provider_events`, `audit_log` |
| Regras determinísticas | PENDENTE | Racha Engine, conciliação |
| Policy Engine | PENDENTE | `POLICY_V1`, decisões negadas e críticas auditadas |
| Expert Library / CEKE | PENDENTE | versões, escopos, vigência, quatro olhos, schema de conteúdo |
| CBR + ledger | PENDENTE | casos automáticos, similaridade (Jaccard), propostas LEARNED |
| Machine Learning | PENDENTE | sem dados — não será criado por criar |
| RAG / RAG Enterprise | PENDENTE | sem corpus que justifique; filtro por tenant virá do RLS |
| MCP | PENDENTE | entra quando houver ferramentas estáveis expostas a agentes |
| Small LLM / LLM externo | PENDENTE | interface + adapter Anthropic; só PARCIAL até testar contra a API real |
| Fine-tuning | PENDENTE | só com baseline e métrica (Constituição §13) |
| Skills | PENDENTE | `ReceiptUnderstandingSkill`, `ReconciliationExplanationSkill` com manifesto |
| Agentes | PENDENTE | chaves de API com `actor_type = AI` serão bloqueadas pela Policy Engine |

## Dinheiro

- Sempre centavos inteiros (`bigint` no banco). Multiplicações internas em `BigInt`.
- Arredondamento: maiores restos com desempate pela posição do participante (`ROUNDING.ALLOCATION`).
- Invariantes verificadas em código antes de persistir e cobertas por testes de propriedade (meta: 3.500 cenários aleatórios por execução).

## Segurança

- Multi-tenant por **RLS forçado** (`FORCE ROW LEVEL SECURITY`), inclusive para o dono das tabelas. O servidor **recusa subir em produção** se o papel do banco for superuser/BYPASSRLS.
- Tokens guardados só como SHA-256; tokens de convite/organizador trafegam no fragmento da URL (não chegam ao servidor em logs nem em `Referer`).
- Webhooks de entrada: HMAC + janela de 5 min contra replay + deduplicação por `(provider, event_id)`.
- Webhooks de saída: HMAC, segredo cifrado (AES-256-GCM), retry exponencial, bloqueio de IP privado em produção (SSRF).
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
