-- 0003 — casos CBR (exceções viram casos; humano resolve) e roteamento do worker de expiração.

CREATE TABLE cbr_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  bill_id         uuid NOT NULL REFERENCES bills (id),
  kind            text NOT NULL CHECK (kind IN ('OVERPAYMENT', 'LATE_CONFIRMATION', 'OUT_OF_ORDER_EVENT', 'CHARGEBACK',
                                                'REFUND_AFTER_SETTLEMENT', 'ERP_DIVERGENCE', 'MANUAL_PAYMENT_REJECTED')),
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  payment_id      uuid REFERENCES payments (id),
  participant_id  uuid REFERENCES participants (id),
  -- Atributos para similaridade (Jaccard) — sem dado pessoal.
  features        text[] NOT NULL DEFAULT '{}',
  evidence        jsonb NOT NULL DEFAULT '{}',
  decision        text CHECK (length(decision) BETWEEN 1 AND 120),
  outcome         text CHECK (length(outcome) BETWEEN 1 AND 500),
  resolved_by     text,
  correlation_id  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  CHECK ((status = 'RESOLVED') = (decision IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX cbr_cases_tenant_kind ON cbr_cases (tenant_id, kind, status);

-- Caso resolvido não volta atrás nem muda de decisão.
CREATE FUNCTION rp_cbr_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'caso CBR não pode ser apagado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'caso CBR já resolvido é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.bill_id <> OLD.bill_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.evidence IS DISTINCT FROM OLD.evidence THEN
    RAISE EXCEPTION 'caso CBR: só a resolução pode ser gravada' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cbr_cases_guard BEFORE UPDATE OR DELETE ON cbr_cases FOR EACH ROW EXECUTE FUNCTION rp_cbr_case_guard();
CREATE TRIGGER cbr_cases_no_truncate BEFORE TRUNCATE ON cbr_cases FOR EACH STATEMENT EXECUTE FUNCTION rp_forbid_mutation();

ALTER TABLE cbr_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cbr_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY cbr_cases_scope ON cbr_cases USING (rp_visible(tenant_id, bill_id)) WITH CHECK (rp_visible(tenant_id, bill_id));
GRANT SELECT, INSERT, UPDATE ON cbr_cases TO rachapay_app;

-- Índice de expiração sem RLS forçado (o dono lê pela função abaixo); a aplicação só vê o da própria conta.
CREATE TABLE payment_expiry_index (
  payment_id  uuid PRIMARY KEY REFERENCES payments (id),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  bill_id     uuid NOT NULL REFERENCES bills (id),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX payment_expiry_index_due ON payment_expiry_index (expires_at);
ALTER TABLE payment_expiry_index ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_expiry_index_write ON payment_expiry_index FOR INSERT WITH CHECK (rp_visible(tenant_id, bill_id));
CREATE POLICY payment_expiry_index_delete ON payment_expiry_index FOR DELETE USING (rp_visible(tenant_id, bill_id));
CREATE POLICY payment_expiry_index_select ON payment_expiry_index FOR SELECT USING (rp_visible(tenant_id, bill_id));
GRANT SELECT, INSERT, DELETE ON payment_expiry_index TO rachapay_app;

-- Pagamentos de qualquer tenant com prazo vencido: o worker só recebe o roteamento e
-- processa cada um no escopo da própria conta (RLS continua valendo para a alteração).
CREATE FUNCTION rp_due_expirations(p_now timestamptz, p_limit integer)
RETURNS TABLE (tenant_id uuid, bill_id uuid, payment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.tenant_id, r.bill_id, r.payment_id
    FROM payment_expiry_index r
   WHERE r.expires_at <= p_now
   ORDER BY r.expires_at
   LIMIT p_limit
$$;

REVOKE EXECUTE ON FUNCTION rp_due_expirations(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rp_due_expirations(timestamptz, integer) TO rachapay_app;
