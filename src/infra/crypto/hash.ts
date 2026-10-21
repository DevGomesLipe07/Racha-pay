import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(secret: string | Uint8Array, data: string | Uint8Array): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Comparação em tempo constante de dois hex; tamanhos diferentes = falso. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export const TOKEN_PREFIXES = {
  organizer: 'rpo_',
  share: 'rps_',
  apiKey: 'rpk_',
} as const;
export type TokenKind = keyof typeof TOKEN_PREFIXES;

/** Token de capacidade: prefixo + 32 bytes aleatórios em base64url. Só o SHA-256 é guardado. */
export function newToken(kind: TokenKind): { token: string; hash: string } {
  const token = TOKEN_PREFIXES[kind] + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

export function tokenKind(token: string): TokenKind | undefined {
  for (const [kind, prefix] of Object.entries(TOKEN_PREFIXES) as [TokenKind, string][]) {
    if (token.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(prefix.length))) return kind;
  }
  return undefined;
}
