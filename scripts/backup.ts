// npm run backup -- --out rachapay.dump
// Dump completo (formato custom do pg_dump) com o papel de backup (BACKUP_DATABASE_URL, D22).
// pg_dump vem do PATH ou de PG_BIN. Depois do dump, rode `npm run backup:verify` — backup sem restore
// testado não conta como backup.

import { statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pgTool } from './pg-tools.ts';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const url = process.env.BACKUP_DATABASE_URL;
if (!url || !values.out) {
  process.stderr.write('uso: BACKUP_DATABASE_URL=… npm run backup -- --out arquivo.dump\n');
  process.exit(1);
}

try {
  pgTool('pg_dump', ['--format=custom', '--no-password', `--file=${values.out}`], url);
  process.stdout.write(`backup gravado em ${values.out} (${statSync(values.out).size} bytes)\n`);
} catch (error) {
  process.stderr.write(`falha no backup: ${(error as Error).message}\n`);
  process.exit(1);
}
