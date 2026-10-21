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
| Sistema funciona sem nenhum LLM | **garantido** hoje (não há LLM no código); alvo: `NullAIProvider` como padrão quando a camada de IA entrar |
| LLM substituível, sem SDK no domínio | alvo: `modules/ai/provider.ts` (interface `AIProvider`, adapter HTTP puro) |
| Saída de IA é sugestão confirmada por humano | alvo: `modules/ai/skills.ts` (`requiresConfirmation: true`; nada é gravado na conta) |

## Ordem de maturidade da inteligência

| Camada | Estado | Observação |
|---|---|---|
| Dados e evidências | IMPLEMENTADO | ledger encadeado e imutável no banco, `provider_events`, `audit_log` |
| Regras determinísticas | IMPLEMENTADO | Racha Engine, conciliação, estados D6 |
| Policy Engine | IMPLEMENTADO | `POLICY_V1`; negadas e críticas auditadas |
| Expert Library / CEKE | PARCIAL | 9 regras fundadoras, escopos, vigência, schema de conteúdo, imutabilidade no banco; API de governança (propor/aprovar com quatro olhos) PENDENTE |
| CBR + ledger | PARCIAL | casos automáticos de todas as exceções de pagamento; resolução de OVERPAYMENT pela devolução manual (D3); similaridade (Jaccard), API e propostas LEARNED PENDENTE |
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
- Invariantes verificadas em código antes de persistir e cobertas por testes de propriedade (3.500 cenários aleatórios por execução, semente fixa).

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
