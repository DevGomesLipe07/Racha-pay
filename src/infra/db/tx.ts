// Transações com escopo de tenant e de conta (RLS forçado, D9).
// O RLS lê app.tenant_id e app.bill_id via rp_tenant()/rp_bill(); sem tenant, nenhuma linha é visível.

import type { Pool, PoolClient } from './pool.ts';

export type DbScope =
  /** Credencial de tenant (chave de API / admin do tenant): todas as contas do tenant. */
  | { kind: 'tenant'; tenantId: string }
  /** Token de capacidade (organizador/convidado): só aquela conta. */
  | { kind: 'bill'; tenantId: string; billId: string }
  /** Administrador da plataforma (ADMIN_TOKEN já validado): só conhecimento compartilhado; nenhum dado de tenant. */
  | { kind: 'platform' };

/** Escopo com tenant (credencial de tenant ou token de conta). */
export type TenantDbScope = Exclude<DbScope, { kind: 'platform' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DbScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbScopeError';
  }
}

export async function withScope<T>(pool: Pool, scope: DbScope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (scope.kind !== 'platform' && !UUID.test(scope.tenantId)) throw new DbScopeError('tenantId inválido');
  if (scope.kind === 'bill' && !UUID.test(scope.billId)) throw new DbScopeError('billId inválido');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.bill_id', $2, true), set_config('app.platform_admin', $3, true)",
      [scope.kind === 'platform' ? '' : scope.tenantId, scope.kind === 'bill' ? scope.billId : '', scope.kind === 'platform' ? 'on' : ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Transação sem escopo de tenant: só enxerga o que as funções SECURITY DEFINER expõem. */
export async function withoutScope<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
