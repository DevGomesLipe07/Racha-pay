// Checagem do papel do banco na subida (Constituição § Segurança, D16):
// em produção o servidor recusa subir se o papel contorna RLS ou é dono das tabelas.

import type { Pool } from './pool.ts';

export interface RoleReport {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** O papel é dono de alguma tabela do schema public (poderia desligar RLS/triggers). */
  ownsTables: boolean;
}

export async function inspectRole(pool: Pool): Promise<RoleReport> {
  const { rows } = await pool.query<{ role: string; superuser: boolean; bypass: boolean; owns: boolean }>(`
    SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
           EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = r.rolname) AS owns
      FROM pg_roles r WHERE r.rolname = current_user`);
  const row = rows[0];
  if (!row) throw new Error('não foi possível inspecionar o papel do banco');
  return { role: row.role, superuser: row.superuser, bypassRls: row.bypass, ownsTables: row.owns };
}

export function roleProblems(report: RoleReport): string[] {
  const problems: string[] = [];
  if (report.superuser) problems.push(`o papel ${report.role} é superuser (contorna RLS)`);
  if (report.bypassRls) problems.push(`o papel ${report.role} tem BYPASSRLS`);
  if (report.ownsTables) problems.push(`o papel ${report.role} é dono das tabelas (use rachapay_app em DATABASE_URL e rachapay_owner só em MIGRATION_DATABASE_URL)`);
  return problems;
}
