import type { Prisma } from '@prisma/client'
import type { AuditChange, AuditContext } from '@/domain/audit'

/**
 * The one way an audit entry is ever written.
 *
 * ## Explicit calls, not automatic capture
 *
 * The alternative was a Prisma extension or middleware that logged every write
 * on its way past. It was rejected for three reasons, in order of weight:
 *
 *  1. **It cannot say why.** A middleware sees `unit.update({ priceMinor })`.
 *     It cannot see that an admin repriced a unit, and it certainly cannot see
 *     the reason an admin typed into the void form. "Who changed that unit's
 *     price" is answerable from the row diff; "who voided that payment and
 *     why" is not, and the second question is the one this log exists for.
 *  2. **Business events are not row writes.** Voiding a payment is one event
 *     and four writes: the payment update, the allocation deletes, a recompute
 *     of every touched schedule entry, and possibly a sale status change.
 *     Captured automatically it is four rows of mechanism; recorded explicitly
 *     it is one sentence. In the other direction, the writes that are *pure*
 *     mechanism — `ScheduleEntry.amountPaidMinor` recomputes, `RateLimitHit`
 *     upserts on every login attempt, `PasswordResetToken.usedAt` sweeps —
 *     would drown the log in noise nobody will ever read, in the table that is
 *     already going to be the largest in the database.
 *  3. **There is no actor in scope.** Middleware runs under a query, not under
 *     a request. Getting `who` there means threading an AsyncLocalStorage
 *     through every server action and route handler and hoping nothing runs
 *     outside it — more machinery, more silently-wrong entries, and a log with
 *     the wrong actor is worse than no log.
 *
 * The honest cost of explicit calls is that they can be forgotten. Three things
 * make that hard rather than merely discouraged:
 *
 *   - there is exactly one function, this one, and it is a service-layer call.
 *     No page, no server action and no route handler may import it, and
 *     `src/server/__tests__/audit-call-sites.test.ts` fails if one does;
 *   - that same test asserts every service that moves money, inventory or
 *     access still calls it, so deleting a call is a failing test rather than a
 *     quiet gap;
 *   - it takes the caller's transaction client, so writing it is one line at
 *     the point where the change is already being made.
 *
 * ## Inside the caller's transaction, always
 *
 * `tx` is required, and it is the caller's own. Both failure modes were
 * considered:
 *
 *   - **Inside** (chosen): if the audit insert fails, the money operation rolls
 *     back. The agent sees an error, no money moved, and they retry.
 *   - **Outside**: if the audit insert fails, the payment stands with no record
 *     of who recorded it. Nothing is shown to anybody. The record is quietly,
 *     permanently wrong.
 *
 * For a system of record, the second is the worse failure by a wide margin: the
 * first is visible and recoverable, the second is invisible and cannot be
 * repaired later. And the risk is small in the direction that matters — this is
 * one INSERT into an append-only table with no unique constraint and no foreign
 * key, so it has no business reason to fail; it can only fail if the database
 * is already unavailable, in which case the money write was failing anyway.
 *
 * The codebase already made this exact trade once: `issueReceipt` runs inside
 * `recordPayment`'s transaction so that "a payment must never be able to exist
 * without its receipt". A payment must never be able to exist without a record
 * of who took it either.
 */

/**
 * Who acted. `SessionActor` satisfies this structurally, and so does the user
 * behind a password-reset token — which has no session at all but is still very
 * much a person doing something worth recording.
 */
export interface AuditActor {
  userId: string
  orgId: string
  /**
   * The three real roles, plus PLATFORM for the one actor that is not a member
   * of the organisation it is acting on: the platform operator suspending a
   * developer, recorded in *that developer's* log so their admin can read it.
   *
   * No `User` ever holds PLATFORM — see the enum's comment in schema.prisma.
   * It is here because the alternative was writing that event as ADMIN, which
   * would put a false actor in the one table that must never contain one.
   */
  role: 'ADMIN' | 'AGENT' | 'BUYER' | 'PLATFORM'
  fullName: string
}

/**
 * The models this log knows how to talk about. A union rather than a string so
 * the renderer's link switch stays total and a typo cannot invent a type that
 * no sentence covers.
 */
export type AuditEntityType =
  | 'Sale'
  | 'Payment'
  | 'Unit'
  | 'Project'
  | 'Document'
  | 'User'
  | 'Organization'

export interface AuditInput {
  /** `entity.verb` — see `describeAuditEntry` for the ones that render. */
  action: string
  entityType: AuditEntityType
  entityId: string
  /** The entity's human name *as it is now*, snapshotted into the entry. */
  entityLabel?: string | null
  changes?: AuditChange[]
  context?: AuditContext
}

/**
 * Anything that can write: a `PrismaClient` or an interactive transaction
 * client. Typed as the transaction client because that is the narrower of the
 * two and the only one callers should be passing.
 */
export type AuditWriter = Prisma.TransactionClient

export async function recordAudit(
  tx: AuditWriter,
  actor: AuditActor,
  input: AuditInput
): Promise<void> {
  await tx.auditEntry.create({
    data: {
      // From the actor's session, never from a parameter: an entry attributed
      // to the wrong organisation would be invisible to the org it belongs to
      // and visible to one it does not.
      orgId: actor.orgId,
      actorUserId: actor.userId,
      // Snapshots. The name and role are what were true at the time, so an
      // entry still reads correctly after a rename, a role change or a
      // deactivation — and so rendering a page of entries needs no join.
      actorName: actor.fullName,
      actorRole: actor.role,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel ?? null,
      // Already-tagged plain JSON (see `AuditValue`): money is a decimal string
      // of minor units, so nothing here is a BigInt and the column round-trips.
      changes: (input.changes ?? []) as unknown as Prisma.InputJsonValue,
      context: (input.context ?? {}) as unknown as Prisma.InputJsonValue
    }
  })
}
