// Pix estático (BR Code, padrão EMV-MPM do Manual de Padrões para Iniciação do Pix do Banco Central).
// Gera o "copia e cola" / QR com a chave do organizador e o valor da parte já preenchido. Não passa por
// PSP: o dinheiro vai direto para a conta do organizador e a confirmação continua manual (02 § Pagamentos).

export type PixKeyType = 'CPF' | 'CNPJ' | 'PHONE' | 'EMAIL' | 'EVP';

export class PixKeyError extends Error {
  readonly code = 'INVALID_PIX_KEY';
  constructor(message: string) {
    super(message);
    this.name = 'PixKeyError';
  }
}

function cpfValid(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const digit = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(d[9]) && digit(10) === Number(d[10]);
}

function cnpjValid(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** Normaliza e valida a chave; devolve o formato que vai no BR Code. */
export function normalizePixKey(raw: string): { key: string; type: PixKeyType } {
  const v = raw.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return { key: v.toLowerCase(), type: 'EVP' };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    if (v.length > 77) throw new PixKeyError('e-mail longo demais para chave Pix');
    return { key: v.toLowerCase(), type: 'EMAIL' };
  }
  const digits = v.replace(/\D/g, '');
  if (/^\+/.test(v) || (/^\(?\d{2}\)?\s?9?\d{4}-?\d{4}$/.test(v) && digits.length >= 10 && digits.length <= 11)) {
    const national = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
    if (!/^\d{10,11}$/.test(national)) throw new PixKeyError('telefone inválido: use DDD + número');
    return { key: `+55${national}`, type: 'PHONE' };
  }
  if (digits.length === 11 && cpfValid(digits)) return { key: digits, type: 'CPF' };
  if (digits.length === 14 && cnpjValid(digits)) return { key: digits, type: 'CNPJ' };
  throw new PixKeyError('chave Pix não reconhecida (use chave aleatória, e-mail, telefone, CPF ou CNPJ válidos)');
}

/** Mostra a chave sem expô-la inteira (para a tela do organizador). */
export function maskPixKey(key: string, type: PixKeyType): string {
  if (type === 'EVP') return `${key.slice(0, 8)}…${key.slice(-4)}`;
  if (type === 'EMAIL') {
    const [user = '', domain = ''] = key.split('@');
    return `${user.slice(0, 2)}…@${domain}`;
  }
  return `…${key.slice(-4)}`;
}

/** Texto ASCII sem acento, só caracteres aceitos pelos bancos, cortado no limite do campo. */
function emvText(s: string, max: number): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function field(id: string, value: string): string {
  if (value.length > 99) throw new PixKeyError(`campo ${id} longo demais`);
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC16/CCITT-FALSE (polinômio 0x1021, valor inicial 0xFFFF), como exige o BR Code. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export interface BrCodeInput {
  key: string;
  merchantName: string;
  city: string;
  /** Centavos; ausente = o pagador digita o valor. */
  amountCents?: bigint;
  /** Identificador alfanumérico (até 25) — ajuda o organizador a reconhecer o Pix no extrato. */
  txid?: string;
  description?: string;
}

export function buildPixBrCode(input: BrCodeInput): string {
  const account =
    field('00', 'br.gov.bcb.pix') +
    field('01', input.key) +
    (input.description ? field('02', emvText(input.description, Math.max(0, 99 - 22 - input.key.length - 8))) : '');
  const txid = input.txid ? input.txid.replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***' : '***';
  let amount = '';
  if (input.amountCents !== undefined) {
    if (input.amountCents <= 0n) throw new PixKeyError('valor do Pix deve ser positivo');
    const reais = input.amountCents / 100n;
    const cents = (input.amountCents % 100n).toString().padStart(2, '0');
    amount = field('54', `${reais}.${cents}`);
  }
  const payload =
    field('00', '01') +
    field('26', account) +
    field('52', '0000') +
    field('53', '986') +
    amount +
    field('58', 'BR') +
    field('59', emvText(input.merchantName, 25) || 'RACHAPAY') +
    field('60', emvText(input.city, 15) || 'BRASIL') +
    field('62', field('05', txid)) +
    '6304';
  return payload + crc16(payload);
}
