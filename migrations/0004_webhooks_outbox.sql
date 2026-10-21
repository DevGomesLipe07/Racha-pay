-- 0004 — webhooks de saída: endpoints por tenant, outbox transacional alimentado pelo ledger,
-- entregas com retentativa (D17), DEAD e reprocessamento.
--
-- outbox_events e webhook_deliveries têm RLS habilitado SEM FORCE: a aplicação (rachapay_app, D16)
-- continua presa ao escopo; só a função de descoberta do worker (dono) enxerga quais tenants têm trabalho.
-- São tabelas operacionais — a verdade financeira continua no ledger (FORCE RLS).

CREATE TABLE webhook_endpoints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  url               text NOT NULL CHECK (length(url) BETWEEN 8 AND 2000),
  secret_encrypted  text NOT NULL,
  events            text[] NOT NULL DEFAULT '{}',
  description       text CHECK (length(description) <= 200),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_tenant ON webhook_endpoints (tenant_id) WHERE active;
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
-- Só credencial de tenant (escopo sem conta) gerencia endpoints; token de conta não enxerga.
CREATE POLICY webhook_endpoints_tenant ON webhook_endpoints
  USING (tenant_id = rp_tenant() AND rp_bill() IS NULL) WITH CHECK (tenant_id = rp_tenant() AND rp_bill() IS NULL);
GRANT SELECT, INSERT, UPDATE ON webhook_endpoints TO rachapay_app;

CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  bill_id        uuid REFERENCES bills (id),
  type           text NOT NULL CHECK (type IN ('bill.created', 'split.confirmed', 'payment.created', 'payment.confirmed', 'payment.failed',
                                               'payment.refunded', 'payment.chargedback', 'bill.partially_paid', 'bill.settled',
                                               'bill.reopened', 'bill.cancelled')),
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz
);
CREATE INDEX outbox_pending ON outbox_events (tenant_id, created_at) WHERE dispatched_at IS NULL;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_scope ON outbox_events USING (rp_visible(tenant_id, bill_id)) WITH CHECK (rp_visible(tenant_id, bill_id));
GRANT SELECT, INSERT, UPDATE ON outbox_events TO rachapay_app;

CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints (id),
  event_id         uuid NOT NULL REFERENCES outbox_events (id),
  event_type       text NOT NULL,
  status           text NOT NULL CHECK (status IN ('PENDING', 'RETRYING', 'DELIVERED', 'DEAD')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL,
  last_status_code integer,
  last_error       text CHECK (length(last_error) <= 300),
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (tenant_id, next_attempt_at) WHERE status IN ('PENDING', 'RETRYING');
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_deliveries_tenant ON webhook_deliveries
  USING (tenant_id = rp_tenant() AND rp_bill() IS NULL) WITH CHECK (tenant_id = rp_tenant() AND rp_bill() IS NULL);
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO rachapay_app;

-- Espelho mínimo de "tenant tem endpoint ativo", mantido por trigger (a tabela de endpoints é FORCE RLS).
CREATE TABLE webhook_endpoints_index (
  endpoint_id uuid PRIMARY KEY REFERENCES webhook_endpoints (id),
  tenant_id   uuid NOT NULL REFERENCES tenants (id)
);
ALTER TABLE webhook_endpoints_index ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION rp_sync_webhook_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.active THEN
    INSERT INTO webhook_endpoints_index (endpoint_id, tenant_id) VALUES (NEW.id, NEW.tenant_id) ON CONFLICT (endpoint_id) DO NOTHING;
  ELSE
    DELETE FROM webhook_endpoints_index WHERE endpoint_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER webhook_endpoints_sync AFTER INSERT OR UPDATE OF active ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION rp_sync_webhook_index();

-- O tenant tem endpoint ativo? (evita gravar outbox à toa — o tenant Pessoal nunca tem)
CREATE FUNCTION rp_tenant_has_webhooks(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM webhook_endpoints_index i WHERE i.tenant_id = p_tenant)
$$;

-- Tenants com trabalho de webhook (fan-out pendente ou entrega vencida).
CREATE FUNCTION rp_webhook_work(p_now timestamptz) RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.tenant_id FROM outbox_events o WHERE o.dispatched_at IS NULL
  UNION
  SELECT d.tenant_id FROM webhook_deliveries d WHERE d.status IN ('PENDING', 'RETRYING') AND d.next_attempt_at <= p_now
$$;

REVOKE EXECUTE ON FUNCTION rp_tenant_has_webhooks(uuid), rp_webhook_work(timestamptz), rp_sync_webhook_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rp_tenant_has_webhooks(uuid), rp_webhook_work(timestamptz) TO rachapay_app;
