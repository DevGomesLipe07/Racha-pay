-- 0007 — LGPD: retenção e anonimização (D21).
-- Dado pessoal: nomes de participantes e textos livres (título, descrição de item, mesa). O ledger não
-- guarda nomes (só ids), então anonimizar não toca a cadeia de hash nem a prova financeira.

ALTER TABLE bills ADD COLUMN anonymized_at timestamptz;

-- Lista de tenants para rotinas que precisam passar por todos (cada um processado no próprio escopo).
CREATE FUNCTION rp_all_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id FROM tenants ORDER BY created_at
$$;

-- Revoga os links (tokens) de uma conta. Só age sobre a conta visível no escopo da sessão.
CREATE FUNCTION rp_revoke_bill_tokens(p_bill uuid, p_now timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  UPDATE bill_tokens SET revoked_at = p_now
   WHERE bill_id = p_bill AND revoked_at IS NULL AND rp_visible(tenant_id, bill_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE EXECUTE ON FUNCTION rp_all_tenants(), rp_revoke_bill_tokens(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rp_all_tenants(), rp_revoke_bill_tokens(uuid, timestamptz) TO rachapay_app;

-- Regra de retenção (Expert Library; alterável por nova versão com governança).
ALTER TABLE knowledge NO FORCE ROW LEVEL SECURITY;
INSERT INTO knowledge (key, scope_type, scope_value, version, status, critical, origin, content, rationale, author, approved_by, valid_from, activated_at) VALUES
  ('RETENTION.PERSONAL_DATA', 'GLOBAL', '', 1, 'ACTIVE', false, 'FOUNDING', '{"terminalDays": 180, "abandonedDays": 365}',
   'Anonimiza nomes e textos livres 180 dias depois de quitada/cancelada e 365 dias depois da última atividade em conta não concluída (D21).',
   'founding', 'founding-review', '2026-01-01', '2026-01-01');
ALTER TABLE knowledge FORCE ROW LEVEL SECURITY;
