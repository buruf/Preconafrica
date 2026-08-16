/**
 * The application half of "an audit entry is never updated and never deleted".
 *
 * The database half — the half that actually holds — is the trigger in
 * `prisma/audit-immutability.sql`, which raises an exception on any UPDATE or
 * DELETE against `AuditEntry` no matter who issues it: this app, a psql
 * session, a future service, a well-meaning script. That is the guarantee.
 *
 * This is the part that makes a mistake *legible*. Without it, a stray
 * `prisma.auditEntry.deleteMany()` fails deep inside a transaction with a
 * Postgres error about a trigger; with it, the call never reaches the database
 * and the developer gets a sentence explaining why. It also holds on any
 * database where the trigger has not been applied yet.
 *
 * Written as Prisma middleware (`$use`) rather than as a client extension
 * deliberately: `$extends` returns a differently-typed client, and this
 * codebase passes `Prisma.TransactionClient` through a dozen service
 * signatures. Middleware leaves the client's type exactly as it was, and it
 * applies to interactive transaction clients too — which is where every one of
 * these writes actually happens.
 */

/**
 * Every Prisma operation that could change or remove an existing row.
 *
 * `create` and `createMany` are absent on purpose: appending is the only thing
 * anybody is allowed to do here. `upsert` is present because its update branch
 * is an update. Reads are absent for the obvious reason.
 */
export const MUTATING_OPERATIONS: ReadonlySet<string> = new Set([
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany'
])

export const AUDIT_MODEL = 'AuditEntry'

export class AuditImmutabilityError extends Error {
  constructor(action: string) {
    super(
      `Audit entries are append-only: ${AUDIT_MODEL}.${action} is refused. ` +
        'Record a new entry describing the correction instead — the log is the ' +
        'record of what happened, including what happened by mistake.'
    )
    this.name = 'AuditImmutabilityError'
  }
}

/**
 * The guard itself, as a pure decision so it can be proven rather than asserted:
 * given a model and an action, may this query proceed?
 */
export function refusesQuery(model: string | undefined, action: string): boolean {
  return model === AUDIT_MODEL && MUTATING_OPERATIONS.has(action)
}

/**
 * The middleware Prisma installs. Kept to two lines of behaviour so the thing
 * under test is `refusesQuery`, not a closure over a client.
 */
export async function auditImmutabilityMiddleware<
  P extends { model?: string; action: string }
>(params: P, next: (params: P) => Promise<unknown>): Promise<unknown> {
  if (refusesQuery(params.model, params.action)) throw new AuditImmutabilityError(params.action)
  return next(params)
}
