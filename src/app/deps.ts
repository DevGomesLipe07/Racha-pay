import type { Config } from '../config.ts';
import type { Clock } from '../infra/clock.ts';
import type { Pool } from '../infra/db/pool.ts';
import type { RateLimiter } from '../infra/http/rate-limit.ts';
import type { Logger } from '../infra/log.ts';
import type { ProviderRegistry } from '../modules/payments/providers.ts';
import type { AIProvider } from '../modules/ai/provider.ts';
import type { MetricsRegistry } from '../infra/metrics.ts';

export interface AppDeps {
  metrics: MetricsRegistry;
  /** IA opcional (padrão: NullAIProvider). O núcleo financeiro não depende dela. */
  ai: AIProvider;
  pool: Pool;
  config: Config;
  clock: Clock;
  logger: Logger;
  rateLimiter: RateLimiter;
  providers: ProviderRegistry;
}
