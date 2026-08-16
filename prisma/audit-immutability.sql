-- Audit entries are append-only, enforced by the database rather than by
-- convention.
--
-- This is the guarantee. The Prisma middleware in src/server/audit/immutability.ts
-- gives a developer a readable error before the query leaves the process, but it
-- only binds this application; a psql session, a migration script, a future
-- service or an ORM upgrade would all sail past it. A trigger does not care who
-- is connected.
--
-- RAISE EXCEPTION rather than a rule that silently does nothing: a delete that
-- appears to succeed while changing nothing is how somebody concludes the log is
-- broken. This one says exactly what it refused and why.
--
-- Idempotent, because scripts/ensure-audit-immutability.mjs runs it after every
-- `prisma db push` — `prisma db push` recreates the table but knows nothing
-- about triggers, so this has to be re-applied whenever the schema is pushed.

CREATE OR REPLACE FUNCTION audit_entry_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'AuditEntry is append-only: % is refused. The audit log is the record of what happened, including what happened by mistake — record a correcting entry instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_entry_no_update ON "AuditEntry";
CREATE TRIGGER audit_entry_no_update
  BEFORE UPDATE ON "AuditEntry"
  FOR EACH ROW EXECUTE FUNCTION audit_entry_is_append_only();

DROP TRIGGER IF EXISTS audit_entry_no_delete ON "AuditEntry";
CREATE TRIGGER audit_entry_no_delete
  BEFORE DELETE ON "AuditEntry"
  FOR EACH ROW EXECUTE FUNCTION audit_entry_is_append_only();

-- TRUNCATE bypasses row-level triggers entirely, so it needs its own statement-
-- level one. Without this, `TRUNCATE "AuditEntry"` would empty the table in
-- silence and the two triggers above would never fire.
DROP TRIGGER IF EXISTS audit_entry_no_truncate ON "AuditEntry";
CREATE TRIGGER audit_entry_no_truncate
  BEFORE TRUNCATE ON "AuditEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_entry_is_append_only();
