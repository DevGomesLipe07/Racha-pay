// RachaPay → PaymentProvider → Provider Adapter (prompt mestre § O).
// O sandbox fala o mesmo protocolo que um PSP real (webhook assinado, anti-replay, event_id),
// mas é SÓ TESTE: nenhum dinheiro se move. PSP real: BLOQUEADO até haver contrato e credenciais.

import { randomBytes } from 'node:crypto';
import { hmacSha256Hex, safeEqualHex } from '../../infra/crypto/hash.ts';
import { PAYMENT_EVENT_KINDS, type PaymentEventKind } from './state-machine.ts';

export const REPLAY_WINDOW_SECONDS = 300;

export interface ProviderEvent {
  eventId: string;
  reference: string;
  kind: PaymentEventKind;
  amountCents?: bigint;
}

export class WebhookVerificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
  }
}

export interface PaymentProvider {
  readonly name: string;
  /** Cria a cobrança no provedor. Chamado FORA da trava da conta para PSP remoto (03 § PSP, passo 3). */
  createPayment(input: { paymentId: string; amountCents: bigint }): Promise<{ reference: string; instructions?: Record<string, unknown> }>;
  /** Verifica assinatura + janela anti-replay e normaliza o evento. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, now: Date): ProviderEvent;
}

/** Cabeçalho no formato t=<unix>,v1=<hmac>, assinado sobre "<t>.<corpo bruto>" (03 § Webhooks). */
export function signPayload(secret: string, rawBody: string | Buffer, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${hmacSha256Hex(secret, `${unixSeconds}.${rawBody.toString()}`)}`;
}

export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined, now: Date): void {
  if (!header) throw new WebhookVerificationError('SIGNATURE_MISSING', 'assinatura ausente');
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isSafeInteger(t) || !v1) throw new WebhookVerificationError('SIGNATURE_INVALID', 'assinatura malformada');
  const age = Math.abs(now.getTime() / 1000 - t);
  if (age > REPLAY_WINDOW_SECONDS) throw new WebhookVerificationError('SIGNATURE_EXPIRED', 'assinatura fora da janela de 5 minutos');
  const expected = hmacSha256Hex(secret, `${t}.${rawBody.toString()}`);
  if (!safeEqualHex(expected, v1)) throw new WebhookVerificationError('SIGNATURE_INVALID', 'assinatura inválida');
}

export const SANDBOX_SIGNATURE_HEADER = 'x-sandbox-signature';

export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox';
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  async createPayment(): Promise<{ reference: string; instructions: Record<string, unknown> }> {
    return {
      reference: `sbx_${randomBytes(12).toString('hex')}`,
      instructions: { environment: 'SANDBOX', notice: 'ambiente de teste — nenhum dinheiro é movimentado' },
    };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, now: Date): ProviderEvent {
    verifySignature(this.secret, rawBody, headers[SANDBOX_SIGNATURE_HEADER], now);
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebhookVerificationError('PAYLOAD_INVALID', 'corpo do webhook não é JSON');
    }
    const b = body as Record<string, unknown>;
    if (typeof b.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(b.eventId)) throw new WebhookVerificationError('PAYLOAD_INVALID', 'eventId inválido');
    if (typeof b.reference !== 'string' || !/^sbx_[0-9a-f]{24}$/.test(b.reference)) throw new WebhookVerificationError('PAYLOAD_INVALID', 'reference inválida');
    if (typeof b.kind !== 'string' || !(PAYMENT_EVENT_KINDS as readonly string[]).includes(b.kind)) {
      throw new WebhookVerificationError('PAYLOAD_INVALID', 'kind inválido');
    }
    const event: ProviderEvent = { eventId: b.eventId, reference: b.reference, kind: b.kind as PaymentEventKind };
    if (b.amountCents !== undefined) {
      if (typeof b.amountCents !== 'number' || !Number.isSafeInteger(b.amountCents) || b.amountCents <= 0) {
        throw new WebhookVerificationError('PAYLOAD_INVALID', 'amountCents inválido');
      }
      event.amountCents = BigInt(b.amountCents);
    }
    return event;
  }

  /** Monta um webhook assinado como o provedor mandaria (usado pelo simulador e pelos testes). */
  buildWebhook(event: { eventId: string; reference: string; kind: PaymentEventKind; amountCents?: number }, now: Date): { body: string; signature: string } {
    const body = JSON.stringify(event);
    return { body, signature: signPayload(this.secret, body, Math.floor(now.getTime() / 1000)) };
  }
}

export interface ProviderRegistry {
  get(name: string): PaymentProvider | undefined;
  sandbox?: SandboxProvider;
}

export function createProviderRegistry(opts: { sandboxEnabled: boolean; sandboxSecret: string }): ProviderRegistry {
  const sandbox = opts.sandboxEnabled ? new SandboxProvider(opts.sandboxSecret) : undefined;
  const providers = new Map<string, PaymentProvider>();
  if (sandbox) providers.set(sandbox.name, sandbox);
  return { get: (name) => providers.get(name), ...(sandbox ? { sandbox } : {}) };
}
