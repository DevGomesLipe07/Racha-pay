-- 0002 — Expert Library / CEKE: conhecimento operacional versionado, com escopo e vigência.
-- Escopos: GLOBAL → COUNTRY → SEGMENT → ERP → PSP → TENANT → ESTABLISHMENT (vence o mais específico).
-- Conteúdo nunca é editado: mudança = nova versão. Só o status anda.

CREATE TABLE knowledge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)+$'),
  scope_type   text NOT NULL CHECK (scope_type IN ('GLOBAL', 'COUNTRY', 'SEGMENT', 'ERP', 'PSP', 'TENANT', 'ESTABLISHMENT')),
  scope_value  text NOT NULL DEFAULT '',
  -- NULL = conhecimento compartilhado da plataforma; preenchido em TENANT/ESTABLISHMENT.
  tenant_id    uuid REFERENCES tenants (id),
  version      integer NOT NULL CHECK (version > 0),
  status       text NOT NULL CHECK (status IN ('DRAFT', 'REVIEW', 'APPROVED', 'ACTIVE', 'SUPERSEDED', 'REVOKED', 'EXPIRED')),
  critical     boolean NOT NULL DEFAULT false,
  origin       text NOT NULL CHECK (origin IN ('FOUNDING', 'HUMAN', 'LEARNED')),
  content      jsonb NOT NULL,
  rationale    text NOT NULL DEFAULT '',
  author       text NOT NULL,
  approved_by  text,
  valid_from   timestamptz NOT NULL,
  valid_to     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (key, scope_type, scope_value, tenant_id, version),
  CHECK ((scope_type IN ('TENANT', 'ESTABLISHMENT')) = (tenant_id IS NOT NULL)),
  CHECK (scope_type <> 'GLOBAL' OR scope_value = ''),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (approved_by IS NULL OR approved_by <> author OR NOT critical)
);
CREATE INDEX knowledge_resolve ON knowledge (key, status, scope_type);

CREATE FUNCTION rp_knowledge_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge não pode ser apagado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.key <> OLD.key OR NEW.scope_type <> OLD.scope_type
     OR NEW.scope_value <> OLD.scope_value OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.version <> OLD.version OR NEW.critical <> OLD.critical OR NEW.author <> OLD.author
     OR NEW.origin <> OLD.origin OR NEW.valid_from <> OLD.valid_from THEN
    RAISE EXCEPTION 'conteúdo de conhecimento é imutável: crie uma nova versão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_immutable BEFORE UPDATE OR DELETE ON knowledge FOR EACH ROW EXECUTE FUNCTION rp_knowledge_immutable();
CREATE TRIGGER knowledge_no_truncate BEFORE TRUNCATE ON knowledge FOR EACH STATEMENT EXECUTE FUNCTION rp_forbid_mutation();

ALTER TABLE knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_read ON knowledge FOR SELECT USING (tenant_id IS NULL OR tenant_id = rp_tenant());
CREATE POLICY knowledge_tenant_insert ON knowledge FOR INSERT WITH CHECK (tenant_id = rp_tenant());
CREATE POLICY knowledge_tenant_update ON knowledge FOR UPDATE USING (tenant_id = rp_tenant()) WITH CHECK (tenant_id = rp_tenant());

GRANT SELECT, INSERT, UPDATE ON knowledge TO rachapay_app;

-- ---------------------------------------------------------------------------
-- 9 regras fundadoras (ACTIVE). Como o dono também está sob RLS forçado, a semente
-- desliga o FORCE só durante a própria migration (transação) e religa em seguida.

ALTER TABLE knowledge NO FORCE ROW LEVEL SECURITY;

INSERT INTO knowledge (key, scope_type, scope_value, version, status, critical, origin, content, rationale, author, approved_by, valid_from, activated_at) VALUES
  ('SERVICE_CHARGE.DEFAULT', 'GLOBAL', '', 1, 'ACTIVE', true, 'FOUNDING', '{"bp": 0, "maxBp": 3000}',
   'Sem taxa de serviço por padrão; teto de 30%.', 'founding', 'founding-review', '2026-01-01', '2026-01-01'),
  ('SERVICE_CHARGE.DEFAULT', 'SEGMENT', 'RESTAURANT', 1, 'ACTIVE', true, 'FOUNDING', '{"bp": 1000, "maxBp": 3000}',
   '10% de serviço em restaurantes; teto de 30%.', 'founding', 'founding-review', '2026-01-01', '2026-01-01'),
  ('DISCOUNT.ALLOCATION', 'GLOBAL', '', 1, 'ACTIVE', true, 'FOUNDING', '{"method": "PROPORTIONAL_TO_CONSUMPTION"}',
   'Desconto proporcional ao consumo.', 'founding', 'founding-review', '2026-01-01', '2026-01-01'),
  ('TIP.ALLOCATION', 'GLOBAL', '', 1, 'ACTIVE', true, 'FOUNDING', '{"method": "PROPORTIONAL_TO_CONSUMPTION"}',
   'Gorjeta proporcional ao consumo (D4).', 'founding', 'founding-review', '2026-01-01', '2026-01-01'),
  ('ROUNDING.ALLOCATION', 'GLOBAL', '', 1, 'ACTIVE', true, 'FOUNDING', '{"method": "LARGEST_REMAINDER", "tieBreak": "PARTICIPANT_POSITION"}',
   'Centavos por maiores restos; empate pela ordem dos participantes.', 'founding', 'founding-review', '2026-01-01', '2026-01-01'),
  ('PAYMENT.EXPIRY', 'GLOBAL', '', 1, 'ACTIVE', true, 'FOUNDING', '{"sandboxMinutes": 30, "manualMinutes": 10080}',
   'Pendentes expiram: sandbox 30 min, manual 7 dias.', 'founding', 'founding-review', '2026-01-01', '2026-01-01'),
  ('IDEMPOTENCY.TTL', 'GLOBAL', '', 1, 'ACTIVE', false, 'FOUNDING', '{"hours": 24}',
   'Chave de idempotência vale 24 h (D12).', 'founding', 'founding-review', '2026-01-01', '2026-01-01'),
  ('RATE_LIMIT.ANON_BILL_CREATE', 'GLOBAL', '', 1, 'ACTIVE', false, 'FOUNDING', '{"perMinute": 10, "perHour": 60}',
   'Criação anônima limitada por IP em memória, sem armazenar IP (D11).', 'founding', 'founding-review', '2026-01-01', '2026-01-01'),
  ('WEBHOOK.RETRY', 'GLOBAL', '', 1, 'ACTIVE', false, 'FOUNDING', '{"maxAttempts": 12, "baseSeconds": 10, "maxIntervalSeconds": 21600}',
   '12 tentativas, 10 s dobrando: janela total ≈ 5,7 h (D17).', 'founding', 'founding-review', '2026-01-01', '2026-01-01');

ALTER TABLE knowledge FORCE ROW LEVEL SECURITY;
