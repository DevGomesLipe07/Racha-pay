-- 0001 — núcleo: tenants, credenciais, SharedBill, divisão, pagamentos, ledger, auditoria, RLS.
-- Roda como rachapay_owner (D16). A aplicação (rachapay_app) só recebe o DML concedido no fim.

-- ---------------------------------------------------------------------------
-- Contexto de sessão (D9): app.tenant_id e app.bill_id, definidos por transação (set_config local).
-- Sem tenant, rp_tenant() é NULL e nenhuma política libera linha alguma (fecha por padrão).

CREATE FUNCTION rp_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION rp_bill() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.bill_id', true), '')::uuid $$;

-- Linha visível quando é do tenant da sessão e, em escopo de conta, da conta da sessão.
CREATE FUNCTION rp_visible(row_tenant uuid, row_bill uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT row_tenant = rp_tenant() AND (rp_bill() IS NULL OR row_bill = rp_bill()) $$;

-- Histórico financeiro é imutável: UPDATE/DELETE/TRUNCATE recusados no banco.
CREATE FUNCTION rp_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tabela % é append-only: % proibido', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------
-- Tenants e credenciais. Tabelas de registro: RLS habilitado (a aplicação não lê direto);
-- a resolução de credencial passa por funções SECURITY DEFINER que devolvem só o necessário.

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind       text NOT NULL CHECK (kind IN ('PERSONAL', 'BUSINESS')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_self ON tenants FOR SELECT USING (id = rp_tenant());

-- Tenant fixo do RachaPay Pessoal (B2C, sem cadastro).
INSERT INTO tenants (id, name, kind) VALUES ('00000000-0000-4000-8000-000000000001', 'RachaPay Pessoal', 'PERSONAL');

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  key_hash    text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  scopes      text[] NOT NULL DEFAULT '{}',
  actor_type  text NOT NULL DEFAULT 'SYSTEM' CHECK (actor_type IN ('HUMAN', 'SYSTEM', 'AI')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- SharedBill

CREATE TABLE bills (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  kind                text NOT NULL CHECK (kind IN ('RESTAURANT', 'TRANSPORT', 'TRAVEL', 'MARKET', 'EVENT', 'GIFT', 'FUEL', 'ACCOMMODATION', 'OTHER')),
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  currency            text NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  collection_model    text NOT NULL CHECK (collection_model IN ('ORGANIZER_COLLECTS', 'MERCHANT_COLLECTS')),
  state               text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'OPEN', 'PARTIALLY_PAID', 'SETTLEMENT_PENDING', 'SETTLED', 'REOPENED', 'CANCELLED')),
  split_mode          text NOT NULL DEFAULT 'EQUAL' CHECK (split_mode IN ('EQUAL', 'BY_ITEM', 'PERCENT', 'MANUAL')),
  discount_cents      bigint NOT NULL DEFAULT 0 CHECK (discount_cents BETWEEN 0 AND 100000000000),
  service_bp          integer NOT NULL DEFAULT 0 CHECK (service_bp BETWEEN 0 AND 10000),
  tip_cents           bigint NOT NULL DEFAULT 0 CHECK (tip_cents BETWEEN 0 AND 100000000000),
  active_split_version integer CHECK (active_split_version > 0),
  table_label         text CHECK (length(table_label) BETWEEN 1 AND 40),
  external_reference  text CHECK (length(external_reference) BETWEEN 1 AND 120),
  row_version         integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  cancelled_at        timestamptz,
  UNIQUE (tenant_id, external_reference)
);
CREATE INDEX bills_tenant_state ON bills (tenant_id, state);

CREATE TABLE bill_tokens (
  token_hash     text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  bill_id        uuid NOT NULL REFERENCES bills (id),
  kind           text NOT NULL CHECK (kind IN ('ORGANIZER', 'SHARE')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
ALTER TABLE bill_tokens ENABLE ROW LEVEL SECURITY;
-- A aplicação só emite tokens da conta em escopo; nunca os lê (sem política de SELECT).
CREATE POLICY bill_tokens_issue ON bill_tokens FOR INSERT WITH CHECK (rp_visible(tenant_id, bill_id));

CREATE TABLE participants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  bill_id       uuid NOT NULL REFERENCES bills (id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position      integer NOT NULL CHECK (position >= 0),
  is_organizer  boolean NOT NULL DEFAULT false,
  percent_bp    integer CHECK (percent_bp BETWEEN 0 AND 10000),
  manual_cents  bigint CHECK (manual_cents BETWEEN 0 AND 100000000000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bill_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX participants_one_organizer ON participants (bill_id) WHERE is_organizer;

CREATE TABLE items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  bill_id           uuid NOT NULL REFERENCES bills (id),
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  unit_price_cents  bigint NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 100000000000),
  quantity          integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  external_ref      text CHECK (length(external_ref) BETWEEN 1 AND 120),
  -- NULL = ainda não entrou numa divisão confirmada; depois disso o item é imutável (D2).
  confirmed_version integer CHECK (confirmed_version > 0),
  position          integer NOT NULL CHECK (position >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bill_id, external_ref)
);
CREATE INDEX items_bill ON items (bill_id);

CREATE TABLE item_assignees (
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  bill_id         uuid NOT NULL REFERENCES bills (id),
  item_id         uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
  weight          integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 1000),
  PRIMARY KEY (item_id, participant_id)
);
CREATE INDEX item_assignees_bill ON item_assignees (bill_id);

-- ---------------------------------------------------------------------------
-- Fotografias imutáveis da divisão (02 § SharedBill; D2 complemento = nova versão).

CREATE TABLE split_versions (
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  bill_id         uuid NOT NULL REFERENCES bills (id),
  version         integer NOT NULL CHECK (version > 0),
  kind            text NOT NULL CHECK (kind IN ('CONFIRMED', 'COMPLEMENT')),
  mode            text NOT NULL CHECK (mode IN ('EQUAL', 'BY_ITEM', 'PERCENT', 'MANUAL')),
  subtotal_cents  bigint NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents  bigint NOT NULL CHECK (discount_cents >= 0),
  service_bp      integer NOT NULL CHECK (service_bp >= 0),
  service_cents   bigint NOT NULL CHECK (service_cents >= 0),
  tip_cents       bigint NOT NULL CHECK (tip_cents >= 0),
  total_cents     bigint NOT NULL CHECK (total_cents >= 0),
  rules           jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bill_id, version),
  CHECK (total_cents = subtotal_cents - discount_cents + service_cents + tip_cents)
);

CREATE TABLE split_allocations (
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  bill_id         uuid NOT NULL,
  version         integer NOT NULL,
  participant_id  uuid NOT NULL,
  items_cents     bigint NOT NULL CHECK (items_cents >= 0),
  discount_cents  bigint NOT NULL CHECK (discount_cents >= 0),
  service_cents   bigint NOT NULL CHECK (service_cents >= 0),
  tip_cents       bigint NOT NULL CHECK (tip_cents >= 0),
  -- Devido acumulado do participante nesta versão.
  total_cents     bigint NOT NULL CHECK (total_cents >= 0),
  PRIMARY KEY (bill_id, version, participant_id),
  FOREIGN KEY (bill_id, version) REFERENCES split_versions (bill_id, version),
  CHECK (total_cents = items_cents - discount_cents + service_cents + tip_cents)
);

-- ---------------------------------------------------------------------------
-- Pagamentos

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  bill_id            uuid NOT NULL REFERENCES bills (id),
  participant_id     uuid NOT NULL REFERENCES participants (id),
  method             text NOT NULL CHECK (method IN ('MANUAL', 'SANDBOX') OR method LIKE 'PSP:%'),
  amount_cents       bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000000),
  status             text NOT NULL CHECK (status IN ('CREATED', 'PENDING', 'AUTHORIZED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'REJECTED', 'REFUNDED', 'CHARGEDBACK')),
  refunded_cents     bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  chargedback_cents  bigint NOT NULL DEFAULT 0 CHECK (chargedback_cents >= 0),
  deferred           jsonb NOT NULL DEFAULT '[]',
  provider_reference text,
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at       timestamptz,
  CHECK (refunded_cents + chargedback_cents <= amount_cents)
);
CREATE INDEX payments_bill ON payments (bill_id);
CREATE INDEX payments_expiry ON payments (expires_at) WHERE status IN ('CREATED', 'PENDING', 'AUTHORIZED');

-- Roteamento de webhook de provedor → pagamento (o webhook chega sem tenant). Registro sem leitura direta.
CREATE TABLE provider_routes (
  provider     text NOT NULL,
  reference    text NOT NULL,
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  bill_id      uuid NOT NULL REFERENCES bills (id),
  payment_id   uuid NOT NULL REFERENCES payments (id),
  PRIMARY KEY (provider, reference)
);
ALTER TABLE provider_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY provider_routes_register ON provider_routes FOR INSERT WITH CHECK (rp_visible(tenant_id, bill_id));

-- Eventos recebidos de provedores: deduplicação por (provider, event_id).
CREATE TABLE provider_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  bill_id         uuid NOT NULL REFERENCES bills (id),
  payment_id      uuid NOT NULL REFERENCES payments (id),
  provider        text NOT NULL,
  event_id        text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  kind            text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('APPLIED', 'IGNORED', 'DEFERRED')),
  payload_sha256  text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- D3 — devolução manual de excedente registrada pelo organizador.
CREATE TABLE manual_refunds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  bill_id         uuid NOT NULL REFERENCES bills (id),
  participant_id  uuid NOT NULL REFERENCES participants (id),
  amount_cents    bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000000),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- D12 — idempotência. Em escopo de conta, a chave vale dentro da conta (o tenant Pessoal é compartilhado).
CREATE TABLE idempotency_keys (
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  bill_id          uuid REFERENCES bills (id),
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_sha256   text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX idempotency_keys_scope ON idempotency_keys (tenant_id, COALESCE(bill_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- ---------------------------------------------------------------------------
-- Ledger append-only encadeado por hash (02 § Ledger, D13). O hash é calculado na aplicação
-- (JSON canônico); o banco garante sequência, encadeamento e imutabilidade.

CREATE TABLE ledger_entries (
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  bill_id         uuid NOT NULL REFERENCES bills (id),
  seq             integer NOT NULL CHECK (seq > 0),
  type            text NOT NULL CHECK (type IN (
                    'BILL_CREATED', 'SPLIT_CONFIRMED', 'SPLIT_COMPLEMENTED', 'SPLIT_UNLOCKED',
                    'ORGANIZER_SHARE_SELF_SETTLED', 'PAYMENT_CREATED', 'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED',
                    'PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'PAYMENT_EXPIRED', 'PAYMENT_REJECTED',
                    'PAYMENT_REFUNDED', 'PAYMENT_CHARGEDBACK', 'REFUND_RECORDED', 'BILL_STATE_CHANGED',
                    'BILL_CANCELLED', 'ERP_ACKNOWLEDGED')),
  payload         jsonb NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('HUMAN', 'SYSTEM', 'AI')),
  actor_id        text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  correlation_id  text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
  occurred_at     text NOT NULL CHECK (occurred_at ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'),
  prev_hash       text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash      text NOT NULL UNIQUE CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bill_id, seq)
);

CREATE FUNCTION rp_ledger_chain_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq integer;
  last_hash text;
BEGIN
  SELECT seq, entry_hash INTO last_seq, last_hash
    FROM ledger_entries WHERE bill_id = NEW.bill_id ORDER BY seq DESC LIMIT 1;
  IF last_seq IS NULL THEN
    IF NEW.seq <> 1 OR NEW.prev_hash <> repeat('0', 64) THEN
      RAISE EXCEPTION 'ledger: primeira entrada deve ter seq 1 e prev_hash gênese' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.seq <> last_seq + 1 OR NEW.prev_hash <> last_hash THEN
    RAISE EXCEPTION 'ledger: encadeamento inválido (seq %, esperado %)', NEW.seq, last_seq + 1 USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ledger_chain_check BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION rp_ledger_chain_check();

-- ---------------------------------------------------------------------------
-- Auditoria (Policy Engine: decisões negadas e críticas).

CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants (id),
  bill_id         uuid,
  actor_type      text NOT NULL CHECK (actor_type IN ('HUMAN', 'SYSTEM', 'AI', 'ANONYMOUS')),
  actor_id        text NOT NULL,
  action          text NOT NULL,
  allowed         boolean NOT NULL,
  reason          text NOT NULL,
  policy_version  text NOT NULL,
  correlation_id  text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant ON audit_log (tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- Imutabilidade do histórico financeiro.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_entries', 'split_versions', 'split_allocations', 'provider_events', 'manual_refunds', 'audit_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION rp_forbid_mutation()', t || '_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION rp_forbid_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RLS forçado nas tabelas de dados (vale também para o dono das tabelas).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['participants', 'items', 'item_assignees', 'split_versions', 'split_allocations',
                           'payments', 'provider_events', 'manual_refunds', 'idempotency_keys', 'ledger_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (rp_visible(tenant_id, bill_id)) WITH CHECK (rp_visible(tenant_id, bill_id))', t || '_scope', t);
  END LOOP;
END $$;

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills FORCE ROW LEVEL SECURITY;
CREATE POLICY bills_scope ON bills USING (rp_visible(tenant_id, id)) WITH CHECK (rp_visible(tenant_id, id));

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_read ON audit_log FOR SELECT USING (tenant_id = rp_tenant());
-- Grava a decisão no tenant da sessão, ou sem tenant quando a credencial nem foi reconhecida.
CREATE POLICY audit_log_write ON audit_log FOR INSERT WITH CHECK (tenant_id IS NOT DISTINCT FROM rp_tenant());

-- ---------------------------------------------------------------------------
-- Resolução de credenciais (SECURITY DEFINER, dono = rachapay_owner). Devolvem só o necessário.

CREATE FUNCTION rp_resolve_bill_token(p_hash text)
RETURNS TABLE (tenant_id uuid, bill_id uuid, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.tenant_id, t.bill_id, t.kind FROM bill_tokens t WHERE t.token_hash = p_hash AND t.revoked_at IS NULL
$$;

CREATE FUNCTION rp_resolve_api_key(p_hash text)
RETURNS TABLE (key_id uuid, tenant_id uuid, tenant_kind text, scopes text[], actor_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.id, k.tenant_id, tn.kind, k.scopes, k.actor_type
    FROM api_keys k JOIN tenants tn ON tn.id = k.tenant_id
   WHERE k.key_hash = p_hash AND k.revoked_at IS NULL
$$;

CREATE FUNCTION rp_resolve_provider_route(p_provider text, p_reference text)
RETURNS TABLE (tenant_id uuid, bill_id uuid, payment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.tenant_id, r.bill_id, r.payment_id FROM provider_routes r WHERE r.provider = p_provider AND r.reference = p_reference
$$;

-- ---------------------------------------------------------------------------
-- Privilégios da aplicação: só DML, e só o necessário (histórico: só INSERT/SELECT).

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT SELECT ON tenants TO rachapay_app;
GRANT SELECT, INSERT, UPDATE ON bills, payments TO rachapay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON participants, items, item_assignees, idempotency_keys TO rachapay_app;
GRANT SELECT, INSERT ON split_versions, split_allocations, provider_events, manual_refunds, ledger_entries, audit_log TO rachapay_app;
GRANT INSERT ON bill_tokens, provider_routes TO rachapay_app;
GRANT EXECUTE ON FUNCTION rp_tenant(), rp_bill(), rp_visible(uuid, uuid),
  rp_resolve_bill_token(text), rp_resolve_api_key(text), rp_resolve_provider_route(text, text) TO rachapay_app;
GRANT EXECUTE ON FUNCTION rp_forbid_mutation(), rp_ledger_chain_check() TO rachapay_app;
