// AES-256-GCM para segredos em repouso (ex.: segredo de webhook de saída).
// Formato: v1.<iv base64url>.<tag base64url>.<ciphertext base64url>

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class AeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AeadError';
  }
}

export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new AeadError('APP_ENCRYPTION_KEY deve ter 32 bytes em base64');
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string, associatedData = ''): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(key: Buffer, sealed: string, associatedData = ''): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new AeadError('formato de segredo cifrado inválido');
  const [, iv, tag, ciphertext] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new AeadError('falha ao decifrar segredo (chave errada ou dado adulterado)');
  }
}
