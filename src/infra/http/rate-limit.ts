// Rate limit (D11). A chave do cliente é o IP com HMAC de um sal derivado da APP_ENCRYPTION_KEY: o IP não é
// armazenado nem em memória, e todas as instâncias derivam a mesma chave para o mesmo IP.
//   MemoryRateLimiter   — por instância (testes, instância única)
//   PostgresRateLimiter — compartilhado entre instâncias (padrão em produção)

import { createHmac } from 'node:crypto';
import type { Pool } from '../db/pool.ts';

export function clientKeyFromIp(ip: string, salt: string): string {
  return createHmac('sha256', salt).update(ip).digest('base64url').slice(0, 22);
}

export function rateLimitSalt(encryptionKey: string): string {
  return createHmac('sha256', encryptionKey).update('rachapay:rate-limit:v1').digest('base64url');
}

export interface Limits {
  perMinute: number;
  perHour: number;
}

export interface HitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(bucket: string, key: string, limits: Limits): Promise<HitResult>;
}

interface Window {
  minuteStart: number;
  minuteCount: number;
  hourStart: number;
  hourCount: number;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async hit(bucket: string, key: string, limits: Limits): Promise<HitResult> {
    const t = this.now();
    const id = `${bucket}:${key}`;
    const w = this.windows.get(id) ?? { minuteStart: t, minuteCount: 0, hourStart: t, hourCount: 0 };
    if (t - w.minuteStart >= 60_000) {
      w.minuteStart = t;
      w.minuteCount = 0;
    }
    if (t - w.hourStart >= 3_600_000) {
      w.hourStart = t;
      w.hourCount = 0;
    }
    if (w.minuteCount >= limits.perMinute) {
      this.windows.set(id, w);
      return { allowed: false, retryAfterSeconds: Math.ceil((60_000 - (t - w.minuteStart)) / 1000) };
    }
    if (w.hourCount >= limits.perHour) {
      this.windows.set(id, w);
      return { allowed: false, retryAfterSeconds: Math.ceil((3_600_000 - (t - w.hourStart)) / 1000) };
    }
    w.minuteCount++;
    w.hourCount++;
    this.windows.set(id, w);
    if (this.windows.size > 50_000) this.sweep(t);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(t: number): void {
    for (const [id, w] of this.windows) if (t - w.hourStart >= 3_600_000) this.windows.delete(id);
  }
}

/** Janelas fixas (minuto e hora, alinhadas ao relógio) contadas no PostgreSQL com UPSERT atômico. */
export class PostgresRateLimiter implements RateLimiter {
  private readonly pool: Pool;
  private readonly now: () => number;

  constructor(pool: Pool, now: () => number = Date.now) {
    this.pool = pool;
    this.now = now;
  }

  async hit(bucket: string, key: string, limits: Limits): Promise<HitResult> {
    const t = this.now();
    const minute = Math.floor(t / 60_000) * 60_000;
    const hour = Math.floor(t / 3_600_000) * 3_600_000;
    // Conta só se ainda houver espaço nas duas janelas (a tentativa recusada não consome cota).
    const { rows } = await this.pool.query<{ minute_hits: number; hour_hits: number }>(
      `WITH cur AS (
         SELECT COALESCE(MAX(hits) FILTER (WHERE window_kind = 'minute'), 0) AS m,
                COALESCE(MAX(hits) FILTER (WHERE window_kind = 'hour'), 0) AS h
           FROM rate_limit_hits
          WHERE bucket = $1 AND client_key = $2
            AND ((window_kind = 'minute' AND window_start = $3) OR (window_kind = 'hour' AND window_start = $4))
       )
       SELECT m AS minute_hits, h AS hour_hits FROM cur`,
      [bucket, key, new Date(minute), new Date(hour)],
    );
    const cur = rows[0] ?? { minute_hits: 0, hour_hits: 0 };
    if (cur.minute_hits >= limits.perMinute) return { allowed: false, retryAfterSeconds: Math.ceil((minute + 60_000 - t) / 1000) };
    if (cur.hour_hits >= limits.perHour) return { allowed: false, retryAfterSeconds: Math.ceil((hour + 3_600_000 - t) / 1000) };
    const { rows: after } = await this.pool.query<{ window_kind: string; hits: number }>(
      `INSERT INTO rate_limit_hits (bucket, client_key, window_kind, window_start, hits)
       VALUES ($1, $2, 'minute', $3, 1), ($1, $2, 'hour', $4, 1)
       ON CONFLICT (bucket, client_key, window_kind, window_start) DO UPDATE SET hits = rate_limit_hits.hits + 1
       RETURNING window_kind, hits`,
      [bucket, key, new Date(minute), new Date(hour)],
    );
    // Corrida entre instâncias: se outra passou na frente e estourou, esta também é recusada.
    const m = after.find((r) => r.window_kind === 'minute')?.hits ?? 0;
    const h = after.find((r) => r.window_kind === 'hour')?.hits ?? 0;
    if (m > limits.perMinute) return { allowed: false, retryAfterSeconds: Math.ceil((minute + 60_000 - t) / 1000) };
    if (h > limits.perHour) return { allowed: false, retryAfterSeconds: Math.ceil((hour + 3_600_000 - t) / 1000) };
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
