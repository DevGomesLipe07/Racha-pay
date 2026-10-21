// npm run migrate — aplica as migrations com o papel dono (MIGRATION_DATABASE_URL, D16).
// Idempotente; recusa migration editada depois de aplicada (checksum).

import { migrate } from '../src/infra/db/migrate.ts';
import { createPool } from '../src/infra/db/pool.ts';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  process.stderr.write('defina MIGRATION_DATABASE_URL (papel rachapay_owner)\n');
  process.exit(1);
}
const pool = createPool(url, { max: 1, applicationName: 'rachapay-migrate' });
try {
  const result = await migrate(pool);
  process.stdout.write(
    result.applied.length > 0
      ? `aplicadas: ${result.applied.join(', ')} (já existiam ${result.alreadyApplied})\n`
      : `nada a aplicar (${result.alreadyApplied} já aplicadas)\n`,
  );
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
