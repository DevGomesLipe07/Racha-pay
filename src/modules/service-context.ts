import type { LedgerActor } from './ledger/chain.ts';

/** Contexto de toda operação de serviço: quem, em qual tenant, com qual correlação e "agora" único. */
export interface ServiceContext {
  tenantId: string;
  actor: LedgerActor;
  correlationId: string;
  /** Instante único da operação (relógio injetado, D15). */
  now: Date;
}
