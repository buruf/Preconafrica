import type { Prisma } from '@prisma/client'
import type { PlatformActor } from '@/server/session'

/**
 * The one way a platform operator's action is ever recorded.
 *
 * The sibling of `recordAudit`, and it follows every rule that one does — the
 * actor comes from the guard rather than from a parameter, the write shares the
 * caller's transaction so an action can never exist without its record, and the
 * table it writes to refuses UPDATE, DELETE and TRUNCATE at the database.
 *
 * It is a separate function writing a separate table for one reason:
 * `AuditEntry` is org-scoped, and a platform action crosses organisations. It
 * could have been forced in with a nullable `orgId` — but the platform admin is
 * deliberately unable to read a developer's data, so an entry filed under a
 * developer would be a record of their own action that they could never see.
 * A log its author cannot read is not an audit trail.
 *
 * Known gap, stated where someone will find it: the developer does not yet see
 * in *their* log that they were suspended, or by whom. That is worth adding —
 * it is their organisation — but it is a second entry in a second table, not a
 * reason to hold the console back.
 */
export interface PlatformAuditInput {
  /** Past tense, dot-namespaced: `developer.created`, `developer.suspended`. */
  action: string
  entityType: string
  entityId: string
  /** What a human calls it — the developer's name, not their cuid. */
  entityLabel?: string
  /** Anything the sentence needs that is not a column. */
  context?: Record<string, unknown>
}

export async function recordPlatformAudit(
  tx: Prisma.TransactionClient,
  actor: PlatformActor,
  input: PlatformAuditInput
): Promise<void> {
  await tx.platformAuditEntry.create({
    data: {
      actorUserId: actor.userId,
      // Denormalised on purpose, exactly as `AuditEntry.actorName` is: the log
      // has to still read correctly years later, after the operator's account
      // has been renamed or removed. A join would make the past mutable.
      actorName: actor.fullName,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel ?? null,
      context: (input.context ?? {}) as Prisma.InputJsonValue
    }
  })
}
