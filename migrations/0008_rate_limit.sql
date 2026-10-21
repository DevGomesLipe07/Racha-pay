-- 0008 — rate limit compartilhado entre instâncias (D11). Guarda só a chave derivada do IP por HMAC
-- (o IP nunca é armazenado) e contadores por janela. Não é dado de tenant: sem RLS, acesso só por grant.

CREATE TABLE rate_limit_hits (
  bucket        text NOT NULL CHECK (length(bucket) BETWEEN 1 AND 60),
  client_key    text NOT NULL CHECK (client_key ~ '^[A-Za-z0-9_-]{10,64}$'),
  window_kind   text NOT NULL CHECK (window_kind IN ('minute', 'hour')),
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (bucket, client_key, window_kind, window_start)
);
CREATE INDEX rate_limit_hits_window ON rate_limit_hits (window_start);

GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_hits TO rachapay_app;
