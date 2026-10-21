import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { canonicalJson, CanonicalJsonError } from '../../src/infra/crypto/canonical-json.ts';
import { hashToken, hmacSha256Hex, newToken, safeEqualHex, sha256Hex, tokenKind } from '../../src/infra/crypto/hash.ts';
import { AeadError, decryptSecret, encryptSecret, parseEncryptionKey } from '../../src/infra/crypto/aead.ts';

test('JSON canônico: chaves ordenadas, sem espaços, bigint como inteiro', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 2n, y: undefined } }), '{"a":[true,null,"x"],"b":1,"c":{"z":2}}');
  assert.equal(canonicalJson({ amount: 8990n }), canonicalJson({ amount: 8990 }));
  assert.equal(canonicalJson('ação "x"'), '"ação \\"x\\""');
  assert.equal(canonicalJson(-0), '0');
});

test('JSON canônico: recusa frações, NaN, Date e undefined em array', () => {
  for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, new Date(), [undefined], new Map(), () => 1]) {
    assert.throws(() => canonicalJson(bad), CanonicalJsonError);
  }
});

test('SHA-256 e HMAC conhecidos', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // RFC 4231, caso 2
  assert.equal(
    hmacSha256Hex('Jefe', 'what do ya want for nothing?'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
});

test('comparação em tempo constante', () => {
  assert.equal(safeEqualHex('abcd', 'abcd'), true);
  assert.equal(safeEqualHex('abcd', 'abce'), false);
  assert.equal(safeEqualHex('abcd', 'abc'), false);
  assert.equal(safeEqualHex('zz', 'zz'), false);
});

test('tokens de capacidade: prefixo, entropia e só o hash é guardado', () => {
  const org = newToken('organizer');
  const share = newToken('share');
  assert.match(org.token, /^rpo_[A-Za-z0-9_-]{43}$/);
  assert.equal(tokenKind(org.token), 'organizer');
  assert.equal(tokenKind(share.token), 'share');
  assert.equal(tokenKind('rpo_curto'), undefined);
  assert.equal(org.hash, hashToken(org.token));
  assert.notEqual(org.token, newToken('organizer').token);
});

test('AES-256-GCM: ida e volta, adulteração e chave errada são detectadas', () => {
  const key = randomBytes(32);
  const sealed = encryptSecret(key, 'segredo-do-webhook', 'endpoint:1');
  assert.equal(decryptSecret(key, sealed, 'endpoint:1'), 'segredo-do-webhook');
  assert.notEqual(encryptSecret(key, 'x'), encryptSecret(key, 'x'));
  assert.throws(() => decryptSecret(key, sealed, 'endpoint:2'), AeadError);
  assert.throws(() => decryptSecret(randomBytes(32), sealed, 'endpoint:1'), AeadError);
  const parts = sealed.split('.');
  parts[3] = Buffer.from('outra coisa').toString('base64url');
  assert.throws(() => decryptSecret(key, parts.join('.'), 'endpoint:1'), AeadError);
  assert.throws(() => parseEncryptionKey(Buffer.alloc(16).toString('base64')), AeadError);
});
