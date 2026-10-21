// Configuração validada na subida. Produção recusa segredos de desenvolvimento.

import { z } from 'zod';

/** Valores de `.env.example` — nunca aceitos em produção. */
export const DEV_SECRETS = {
  APP_ENCRYPTION_KEY: 'ZGV2LW9ubHktMzItYnl0ZXMta2V5LWZvci1yYWNoYXA=',
  ADMIN_TOKEN: 'dev-admin-token-change-me-0000000000000000',
  SANDBOX_WEBHOOK_SECRET: 'dev-sandbox-webhook-secret-change-me',
} as const;

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'APP_ENCRYPTION_KEY deve ter 32 bytes em base64'),
  ADMIN_TOKEN: z.string().min(32, 'ADMIN_TOKEN deve ter pelo menos 32 caracteres'),
  SANDBOX_ENABLED: bool.default(true),
  SANDBOX_WEBHOOK_SECRET: z.string().min(16, 'SANDBOX_WEBHOOK_SECRET deve ter pelo menos 16 caracteres'),
  TRUST_PROXY: bool.default(false),
  AI_PROVIDER: z.enum(['none', 'anthropic']).default('none'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-5-5'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`configuração inválida:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`));
  }
  const config = parsed.data;
  const problems: string[] = [];

  if (config.AI_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY) {
    problems.push('AI_PROVIDER=anthropic exige ANTHROPIC_API_KEY');
  }
  if (config.NODE_ENV === 'production') {
    for (const [key, devValue] of Object.entries(DEV_SECRETS) as [keyof typeof DEV_SECRETS, string][]) {
      if (config[key] === devValue) problems.push(`${key} está com o valor de desenvolvimento`);
    }
    if (!config.PUBLIC_BASE_URL.startsWith('https://')) problems.push('PUBLIC_BASE_URL deve usar https em produção');
    if (!/sslmode=(require|verify-ca|verify-full)/.test(config.DATABASE_URL)) {
      problems.push('DATABASE_URL deve exigir SSL em produção (sslmode=require)');
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
