import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ConfigError, DEV_SECRETS, loadConfig } from '../../src/config.ts';

const dev = {
  DATABASE_URL: 'postgresql://rachapay_app:x@localhost:5432/rachapay',
  ...DEV_SECRETS,
};

test('desenvolvimento aceita os segredos de exemplo e aplica padrões', () => {
  const c = loadConfig(dev);
  assert.equal(c.NODE_ENV, 'development');
  assert.equal(c.PORT, 3000);
  assert.equal(c.SANDBOX_ENABLED, true);
  assert.equal(c.AI_PROVIDER, 'none');
});

test('a chave de exemplo tem exatamente 32 bytes', () => {
  assert.equal(Buffer.from(DEV_SECRETS.APP_ENCRYPTION_KEY, 'base64').length, 32);
});

test('produção recusa segredos de desenvolvimento, http e banco sem SSL', () => {
  try {
    loadConfig({ ...dev, NODE_ENV: 'production' });
    assert.fail('deveria recusar');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    const text = e.problems.join('\n');
    for (const k of ['APP_ENCRYPTION_KEY', 'ADMIN_TOKEN', 'SANDBOX_WEBHOOK_SECRET', 'https', 'SSL']) assert.match(text, new RegExp(k));
  }
});

test('produção sobe com segredos próprios, https e sslmode=require', () => {
  const c = loadConfig({
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://rachapay.example',
    DATABASE_URL: 'postgresql://rachapay_app:s@db:5432/rachapay?sslmode=require',
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ADMIN_TOKEN: randomBytes(32).toString('hex'),
    SANDBOX_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
    SANDBOX_ENABLED: 'false',
  });
  assert.equal(c.SANDBOX_ENABLED, false);
});

test('valores inválidos são listados', () => {
  assert.throws(() => loadConfig({ ...dev, APP_ENCRYPTION_KEY: 'curta', PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ ...dev, AI_PROVIDER: 'anthropic' }), /ANTHROPIC_API_KEY/);
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});
