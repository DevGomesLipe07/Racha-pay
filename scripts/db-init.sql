-- RachaPay — inicialização do PostgreSQL (rodar UMA vez, como administrador):
--   psql -U postgres -f scripts/db-init.sql
--
-- Dois papéis, ambos SEM superuser e SEM BYPASSRLS (D16):
--   rachapay_owner — dono do schema; só roda migrations (MIGRATION_DATABASE_URL).
--   rachapay_app   — usado pela aplicação (DATABASE_URL); só DML concedido pelas migrations.
-- Assim a aplicação não consegue desligar RLS nem remover as triggers do ledger.
--
-- TROQUE AS SENHAS fora do ambiente de desenvolvimento.

SELECT 'CREATE ROLE rachapay_owner LOGIN PASSWORD ''rachapay_owner_dev'' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rachapay_owner')\gexec

SELECT 'CREATE ROLE rachapay_app LOGIN PASSWORD ''rachapay_dev'' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rachapay_app')\gexec

SELECT 'CREATE DATABASE rachapay OWNER rachapay_owner ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'rachapay')\gexec

SELECT 'CREATE DATABASE rachapay_test OWNER rachapay_owner ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'rachapay_test')\gexec

REVOKE ALL ON DATABASE rachapay FROM PUBLIC;
REVOKE ALL ON DATABASE rachapay_test FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE rachapay TO rachapay_app;
GRANT CONNECT, TEMPORARY ON DATABASE rachapay_test TO rachapay_app;

\connect rachapay
ALTER SCHEMA public OWNER TO rachapay_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rachapay_app;

\connect rachapay_test
ALTER SCHEMA public OWNER TO rachapay_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rachapay_app;
