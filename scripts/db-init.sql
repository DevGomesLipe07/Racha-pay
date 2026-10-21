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

-- rachapay_backup — SÓ LEITURA, com BYPASSRLS (D22): o pg_dump precisa ler todas as linhas, e o RLS
-- forçado bloqueia os outros papéis. Use apenas na rotina de backup (BACKUP_DATABASE_URL).
SELECT 'CREATE ROLE rachapay_backup LOGIN PASSWORD ''rachapay_backup_dev'' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rachapay_backup')\gexec
GRANT pg_read_all_data TO rachapay_backup;

SELECT 'CREATE DATABASE rachapay OWNER rachapay_owner ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'rachapay')\gexec

SELECT 'CREATE DATABASE rachapay_test OWNER rachapay_owner ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'rachapay_test')\gexec

REVOKE ALL ON DATABASE rachapay FROM PUBLIC;
REVOKE ALL ON DATABASE rachapay_test FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE rachapay TO rachapay_app;
GRANT CONNECT, TEMPORARY ON DATABASE rachapay_test TO rachapay_app;
GRANT CONNECT ON DATABASE rachapay TO rachapay_backup;
GRANT CONNECT ON DATABASE rachapay_test TO rachapay_backup;

\connect rachapay
ALTER SCHEMA public OWNER TO rachapay_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rachapay_app;

\connect rachapay_test
ALTER SCHEMA public OWNER TO rachapay_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rachapay_app;
