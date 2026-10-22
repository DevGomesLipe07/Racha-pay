import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPixBrCode, crc16, maskPixKey, normalizePixKey, PixKeyError } from '../../src/modules/payments/pix-brcode.ts';

test('CRC16/CCITT-FALSE: vetor padrão "123456789" = 29B1', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('BR Code: exemplo do manual do Banco Central (chave aleatória, sem valor)', () => {
  const code = buildPixBrCode({ key: '123e4567-e12b-12d1-a456-426655440000', merchantName: 'Fulano de Tal', city: 'BRASILIA' });
  assert.equal(code, '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D');
});

test('BR Code: valor da parte, txid, nome sem acento e limites de campo', () => {
  const code = buildPixBrCode({ key: 'ana@exemplo.com', merchantName: 'Ana Conceição da Silva Albuquerque', city: 'São José dos Campos', amountCents: 4620n, txid: 'RP-ab12-2' });
  assert.match(code, /^000201/);
  assert.match(code, /540546\.20/);
  assert.match(code, /5925Ana Conceicao da Silva Al/);
  assert.match(code, /6015Sao Jose dos Ca/);
  assert.match(code, /62110507RPab122/);
  assert.equal(code.slice(-4), crc16(code.slice(0, -4)), 'CRC confere');
  assert.match(buildPixBrCode({ key: 'a@b.co', merchantName: 'X', city: 'Y', amountCents: 100n }), /54041\.00/);
  assert.match(buildPixBrCode({ key: 'a@b.co', merchantName: 'X', city: 'Y', amountCents: 123456n }), /54071234\.56/);
  assert.throws(() => buildPixBrCode({ key: 'a@b.co', merchantName: 'X', city: 'Y', amountCents: 0n }), PixKeyError);
});

test('chave Pix: formatos aceitos, normalização e recusa do inválido', () => {
  assert.deepEqual(normalizePixKey('529.982.247-25'), { key: '52998224725', type: 'CPF' });
  assert.deepEqual(normalizePixKey('11.222.333/0001-81'), { key: '11222333000181', type: 'CNPJ' });
  assert.deepEqual(normalizePixKey('(11) 98765-4321'), { key: '+5511987654321', type: 'PHONE' });
  assert.deepEqual(normalizePixKey('+55 11 98765-4321'), { key: '+5511987654321', type: 'PHONE' });
  assert.deepEqual(normalizePixKey('Ana@Exemplo.com'), { key: 'ana@exemplo.com', type: 'EMAIL' });
  assert.deepEqual(normalizePixKey('123E4567-E12B-12D1-A456-426655440000'), { key: '123e4567-e12b-12d1-a456-426655440000', type: 'EVP' });
  for (const bad of ['123.456.789-00', '11111111111', 'abc', '', '11.222.333/0001-00']) assert.throws(() => normalizePixKey(bad), PixKeyError, bad);
});

test('chave Pix mascarada para exibição', () => {
  assert.equal(maskPixKey('52998224725', 'CPF'), '…4725');
  assert.equal(maskPixKey('ana@exemplo.com', 'EMAIL'), 'an…@exemplo.com');
  assert.equal(maskPixKey('123e4567-e12b-12d1-a456-426655440000', 'EVP'), '123e4567…0000');
});
