-- 0005 — estabelecimentos (Business) e vínculo da conta com o estabelecimento / ERP.

CREATE TABLE establishments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  external_id  text NOT NULL CHECK (external_id ~ '^[A-Za-z0-9._:-]{1,120}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
ALTER TABLE establishments ENABLE ROW LEVEL SECURITY;
ALTER TABLE establishments FORCE ROW LEVEL SECURITY;
-- Leitura também em escopo de conta (a conta mostra o nome do estabelecimento); escrita só pelo tenant.
CREATE POLICY establishments_read ON establishments FOR SELECT USING (tenant_id = rp_tenant());
CREATE POLICY establishments_write ON establishments FOR INSERT WITH CHECK (tenant_id = rp_tenant() AND rp_bill() IS NULL);
GRANT SELECT, INSERT ON establishments TO rachapay_app;

ALTER TABLE bills ADD COLUMN establishment_id uuid REFERENCES establishments (id);
ALTER TABLE bills ADD COLUMN erp_provider text CHECK (erp_provider ~ '^[a-z0-9-]{1,40}$');
CREATE INDEX bills_establishment ON bills (establishment_id) WHERE establishment_id IS NOT NULL;
