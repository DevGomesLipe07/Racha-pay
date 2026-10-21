// Banco descartável dos testes de integração. O schema é APAGADO e recriado — nunca aponte para produção.

import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '../../src/infra/db/pool.ts';
import { migrate } from '../../src/infra/db/migrate.ts';
import { withScope, type DbScope } from '../../src/infra/db/tx.ts';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://rachapay_app:rachapay_dev@localhost:5432/rachapay_test';
export const TEST_MIGRATION_DATABASE_URL =
  process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgresql://rachapay_owner:rachapay_owner_dev@localhost:5432/rachapay_test';

export const PERSONAL_TENANT = '00000000-0000-4000-8000-000000000001';

if (/prod/i.test(TEST_DATABASE_URL) || /prod/i.test(TEST_MIGRATION_DATABASE_URL)) {
  throw new Error('os testes de integração recriam o schema: recusado para URL que parece produção');
}

export async function resetDatabase(): Promise<void> {
  const owner = createPool(TEST_MIGRATION_DATABASE_URL, { max: 1, applicationName: 'rachapay-test-reset' });
  try {
    await owner.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO rachapay_app;`);
    await migrate(owner);
  } finally {
    await owner.end();
  }
}

export interface TestDb {
  app: Pool;
  owner: Pool;
  close(): Promise<void>;
}

export async function openTestDb(): Promise<TestDb> {
  const app = createPool(TEST_DATABASE_URL, { max: 10, applicationName: 'rachapay-test-app' });
  const owner = createPool(TEST_MIGRATION_DATABASE_URL, { max: 2, applicationName: 'rachapay-test-owner' });
  return {
    app,
    owner,
    async close() {
      await Promise.all([app.end(), owner.end()]);
    },
  };
}

/** Cria um tenant Business (como dono — tabela de registro). */
export async function createTenant(db: TestDb, name = `Tenant ${randomUUID().slice(0, 8)}`): Promise<string> {
  const { rows } = await db.owner.query<{ id: string }>("INSERT INTO tenants (name, kind) VALUES ($1, 'BUSINESS') RETURNING id", [name]);
  return (rows[0] as { id: string }).id;
}

/** Insere uma conta mínima pela aplicação, no escopo da própria conta. */
export async function insertBill(db: TestDb, tenantId: string, title = 'Conta'): Promise<string> {
  const id = randomUUID();
  await withScope(db.app, { kind: 'bill', tenantId, billId: id }, (c) =>
    c.query("INSERT INTO bills (id, tenant_id, kind, title, collection_model) VALUES ($1, $2, 'RESTAURANT', $3, 'MERCHANT_COLLECTS')", [
      id,
      tenantId,
      title,
    ]),
  );
  return id;
}

export function inScope<T>(db: TestDb, scope: DbScope, fn: Parameters<typeof withScope<T>>[2]): Promise<T> {
  return withScope(db.app, scope, fn);
}

/** Captura o código SQLSTATE (ou a mensagem) de uma promessa que deve falhar. */
export async function sqlError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return err.code ?? err.message ?? 'erro';
  }
  return 'SEM ERRO';
}
