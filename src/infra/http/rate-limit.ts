// Rate limit em memória, por instância (D11). A chave do cliente é o IP com HMAC de um sal aleatório
// do processo: o IP não é armazenado nem em memória. Com várias instâncias, mover para PostgreSQL/Redis.

import { createHmac, randomBytes } from 'node:crypto';

const salt = randomBytes(32);

export function clientKeyFromIp(ip: string): string {
  return createHmac('sha256', salt).update(ip).digest('base64url').slice(0, 22);
}

export interface Limits {
  perMinute: number;
  perHour: number;
}

interface Window {
  minuteStart: number;
  minuteCount: number;
  hourStart: number;
  hourCount: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Conta a tentativa e diz se está dentro do limite; `retryAfterSeconds` quando não está. */
  hit(bucket: string, key: string, limits: Limits): { allowed: boolean; retryAfterSeconds: number } {
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
