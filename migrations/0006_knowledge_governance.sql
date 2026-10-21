-- 0006 — governança da Expert Library: máquina de estados no banco e escrita de escopos
-- compartilhados só pelo administrador da plataforma.
--
-- DRAFT → REVIEW → APPROVED → ACTIVE → SUPERSEDED | REVOKED | EXPIRED (02 § Expert Library).
-- ACTIVE exige aprovação registrada; regra crítica exige aprovador ≠ autor (CHECK já existente).

CREATE FUNCTION rp_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(current_setting('app.platform_admin', true), '') = 'on' $$;

CREATE FUNCTION rp_knowledge_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT'    AND NEW.status IN ('REVIEW', 'REVOKED'))
    OR (OLD.status = 'REVIEW'   AND NEW.status IN ('DRAFT', 'APPROVED', 'REVOKED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('ACTIVE', 'REVOKED'))
    OR (OLD.status = 'ACTIVE'   AND NEW.status IN ('SUPERSEDED', 'REVOKED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'transição de conhecimento inválida: % → %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'ACTIVE' AND NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'conhecimento só fica ativo depois de aprovado' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by AND NOT (OLD.status = 'REVIEW' AND NEW.status = 'APPROVED') THEN
    RAISE EXCEPTION 'aprovador só é gravado na aprovação' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_transition_guard BEFORE UPDATE ON knowledge FOR EACH ROW EXECUTE FUNCTION rp_knowledge_transition_guard();

-- No máximo uma versão ACTIVE por chave + escopo (+ tenant).
CREATE UNIQUE INDEX knowledge_one_active ON knowledge (key, scope_type, scope_value, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'ACTIVE';

-- Escopos compartilhados (tenant_id NULL): só com a marca de administrador da plataforma na sessão,
-- que a aplicação põe apenas depois de validar o ADMIN_TOKEN.
CREATE POLICY knowledge_platform_insert ON knowledge FOR INSERT WITH CHECK (tenant_id IS NULL AND rp_platform_admin());
CREATE POLICY knowledge_platform_update ON knowledge FOR UPDATE USING (tenant_id IS NULL AND rp_platform_admin()) WITH CHECK (tenant_id IS NULL AND rp_platform_admin());

GRANT EXECUTE ON FUNCTION rp_platform_admin() TO rachapay_app;
