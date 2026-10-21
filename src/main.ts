// Entrada: configuração → migrations (se MIGRATION_DATABASE_URL) → checagem do papel → servidor.

import { buildServer } from './app/app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { systemClock } from './infra/clock.ts';
import { migrate } from './infra/db/migrate.ts';
import { createPool } from './infra/db/pool.ts';
import { inspectRole, roleProblems } from './infra/db/role-check.ts';
import { RateLimiter } from './infra/http/rate-limit.ts';
import { createLogger } from './infra/log.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  if (config.MIGRATION_DATABASE_URL) {
    const owner = createPool(config.MIGRATION_DATABASE_URL, { max: 1, applicationName: 'rachapay-migrate' });
    try {
      const result = await migrate(owner);
      logger.info('migrations', { applied: result.applied.join(',') || 'nenhuma', alreadyApplied: result.alreadyApplied });
    } finally {
      await owner.end();
    }
  }

  const pool = createPool(config.DATABASE_URL);
  const problems = roleProblems(await inspectRole(pool));
  if (problems.length > 0) {
    if (config.NODE_ENV === 'production') {
      logger.error('database_role_refused', { problems: problems.join('; ') });
      await pool.end();
      process.exit(1);
    }
    logger.warn('database_role_unsafe', { problems: problems.join('; ') });
  }

  const server = buildServer({ pool, config, clock: systemClock, logger, rateLimiter: new RateLimiter() });
  server.listen(config.PORT, () => logger.info('listening', { port: config.PORT, env: config.NODE_ENV }));

  const shutdown = (signal: string) => {
    logger.info('shutdown', { signal });
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`falha na subida: ${(error as Error)?.message ?? String(error)}\n`);
  }
  process.exit(1);
});
