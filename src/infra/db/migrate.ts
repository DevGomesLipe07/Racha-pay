// Migrations versionadas em migrations/NNNN_nome.sql. Cada uma roda numa transação; o checksum
// (SHA-256 do arquivo) protege contra edição depois de aplicada. Advisory lock evita migradores simultâneos.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../crypto/hash.ts';
import type { Pool } from './pool.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));
const LOCK_KEY = 727_224_639; // chave fixa do advisory lock de migrations

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const file of files) {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!match) throw new MigrationError(`nome de migration inválido: ${file}`);
    // Normaliza quebras de linha: o checksum não pode depender de CRLF/LF do checkout.
    const sql = (await readFile(join(dir, file), 'utf8')).replace(/\r\n/g, '\n');
    out.push({ version: Number(match[1]), name: match[2] as string, sql, checksum: sha256Hex(sql) });
  }
  out.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError(`migrations devem ser contínuas a partir de 0001 (achei ${m.version})`);
  });
  return out;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    const applied = new Map(rows.map((r) => [r.version, r]));
    for (const r of rows) {
      const file = migrations.find((m) => m.version === r.version);
      if (!file) throw new MigrationError(`migration ${r.version} aplicada no banco mas ausente no código`);
      if (file.checksum !== r.checksum) {
        throw new MigrationError(`migration ${String(r.version).padStart(4, '0')}_${r.name} foi editada depois de aplicada (checksum diferente)`);
      }
    }
    const result: MigrateResult = { applied: [], alreadyApplied: rows.length };
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MigrationError(`falha na migration ${String(m.version).padStart(4, '0')}_${m.name}: ${(error as Error).message}`);
      }
      result.applied.push(`${String(m.version).padStart(4, '0')}_${m.name}`);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
