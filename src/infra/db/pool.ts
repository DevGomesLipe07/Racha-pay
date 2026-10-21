// Acesso ao PostgreSQL pelo pacote `pg` (decisão do Ciclo 0: nada de driver próprio).

import pg from 'pg';

const INT8_OID = 20;

/** bigint do banco vira BigInt no domínio (D14). Somas devem ser convertidas com ::bigint no SQL. */
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8_OID && format !== 'binary') return (value: string) => BigInt(value);
    return pg.types.getTypeParser(oid, format);
  },
};

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, options: { max?: number; applicationName?: string } = {}): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'rachapay',
    types,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  });
  // Erro em cliente ocioso não pode derrubar o processo; o pool descarta a conexão.
  pool.on('error', () => undefined);
  return pool;
}
