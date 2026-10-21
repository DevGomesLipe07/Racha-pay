// Executa pg_dump/pg_restore sem expor senha: a senha sai da URL e vai só no ambiente do processo filho
// (PGPASSWORD), nunca na linha de comando (visível na lista de processos) nem em mensagem de erro.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function pgTool(name: 'pg_dump' | 'pg_restore', args: string[], url: string): void {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';
  const bin = process.env.PG_BIN ? join(process.env.PG_BIN, name) : name;
  // --dbname antes dos demais: o pg_restore recusa opção depois do arquivo posicional.
  const result = spawnSync(bin, [`--dbname=${parsed.toString()}`, ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PGPASSWORD: password },
  });
  if (result.error) throw new Error(`${name} não pôde ser executado (${(result.error as NodeJS.ErrnoException).code ?? 'erro'}); defina PG_BIN`);
  if (result.status !== 0) throw new Error(`${name} terminou com código ${result.status}`);
}
