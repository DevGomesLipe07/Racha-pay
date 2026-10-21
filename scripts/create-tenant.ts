// npm run tenant:create -- --name "Restaurante X" [--scopes bills:read,bills:write,...] [--actor-type SYSTEM|HUMAN|AI]
// Cria um tenant Business e uma chave de API. A chave aparece UMA vez; só o SHA-256 é guardado.
// Roda com o papel dono (MIGRATION_DATABASE_URL): tenants e chaves não são graváveis pela aplicação.

import { parseArgs } from 'node:util';
import { newToken } from '../src/infra/crypto/hash.ts';
import { createPool } from '../src/infra/db/pool.ts';

const DEFAULT_SCOPES = ['bills:read', 'bills:write', 'payments:create', 'payments:write', 'erp:sync', 'webhooks:write', 'metrics:read', 'cbr:read', 'knowledge:read'];

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    scopes: { type: 'string' },
    'actor-type': { type: 'string', default: 'SYSTEM' },
    'key-name': { type: 'string', default: 'chave inicial' },
  },
});

const url = process.env.MIGRATION_DATABASE_URL;
if (!url || !values.name) {
  process.stderr.write('uso: MIGRATION_DATABASE_URL=… npm run tenant:create -- --name "Restaurante X"\n');
  process.exit(1);
}
const actorType = values['actor-type'] ?? 'SYSTEM';
if (!['SYSTEM', 'HUMAN', 'AI'].includes(actorType)) {
  process.stderr.write('--actor-type deve ser SYSTEM, HUMAN ou AI\n');
  process.exit(1);
}
const scopes = values.scopes ? values.scopes.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_SCOPES;

const pool = createPool(url, { max: 1, applicationName: 'rachapay-tenant-create' });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>("INSERT INTO tenants (name, kind) VALUES ($1, 'BUSINESS') RETURNING id", [values.name]);
    const tenantId = (rows[0] as { id: string }).id;
    const key = newToken('apiKey');
    await client.query('INSERT INTO api_keys (tenant_id, key_hash, name, scopes, actor_type) VALUES ($1, $2, $3, $4, $5)', [
      tenantId,
      key.hash,
      values['key-name'],
      scopes,
      actorType,
    ]);
    await client.query('COMMIT');
    process.stdout.write(`tenant: ${tenantId}\nescopos: ${scopes.join(',')}\nchave (guarde agora, não será mostrada de novo):\n${key.token}\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
