import { redirect } from 'next/navigation'
import { auth } from '@/server/auth'
// db.ts imports nothing from this module (its only import is @prisma/client),
// and errors.ts imports nothing at all, so neither direction can cycle.
import { prisma } from '@/server/db'
import { ServiceError } from '@/server/services/errors'
import { sessionOutdatedByPasswordChange } from '@/domain/password-reset'

export type Role = 'ADMIN' | 'AGENT' | 'BUYER'

export interface SessionActor {
  userId: string
  orgId: string
  role: Role
  buyerId: string | null
  fullName: string
  email: string
}

/**
 * A role failure is a ServiceError with code 'FORBIDDEN', not a separate error
 * family. Every action already funnels `error instanceof ServiceError` into the
 * message it shows the user; as a bare Error this fell through to each
 * action's generic "Could not …" fallback, so the one place that knew what
 * actually went wrong was the only place that could not say it. Subclassing
 * keeps every existing `instanceof AuthorizationError` site working.
 */
export class AuthorizationError extends ServiceError {
  constructor() {
    // Deliberately vague: the message must not disclose which roles qualify.
    super('You do not have access to this resource.', 'FORBIDDEN')
    this.name = 'AuthorizationError'
  }
}

export function assertRole(actor: SessionActor, allowed: Role[]): void {
  if (!allowed.includes(actor.role)) throw new AuthorizationError()
}

/**
 * The one place a JWT is turned into a usable actor — and therefore the only
 * place that can revoke one.
 *
 * A JWT session carries its claims until it expires, so nothing in the token
 * can tell us that the account behind it was deactivated (or deleted) a minute
 * ago, or that its password has since been changed. Both are checked here
 * against the database on every authenticated request: one indexed
 * primary-key read of two nullable columns, which is a price worth paying to
 * make "deactivate this agent" and "reset my password" take effect on the very
 * next navigation rather than up to a week later.
 *
 *   - `disabledAt` revokes on deactivation. `Sale.createdByUserId` is a plain
 *     string rather than a relation, so a user row can genuinely be gone; a
 *     missing row is treated exactly like a disabled one.
 *   - `passwordChangedAt` revokes on password change — reset or self-service.
 *     This is what makes a reset actually eject whoever was already signed in
 *     with the old password. Without it, changing the password would close the
 *     login form and leave an intruder's existing session running for up to a
 *     week, which is the opposite of what the person resetting intended.
 *
 * The second guard costs no extra round trip: it reads a column added to the
 * query the deactivation check was already making.
 */
export async function requireUser(): Promise<SessionActor> {
  const actor = await requireUserOrNull()
  if (!actor) redirect('/login')
  return actor
}

/**
 * `requireUser` for callers that must answer rather than navigate.
 *
 * Identical authentication — the same session read, the same two database
 * checks, in the same order — but it returns null where `requireUser`
 * redirects. An API route cannot usefully bounce a fetch to /login: the caller
 * is an `<a>` to a PDF or an XHR, and a 307 to an HTML page is not an answer.
 * It gets a 401.
 *
 * This exists so that "authenticated" means one thing in this app. The
 * documents route used to call `auth()` directly and check only that a session
 * existed, which quietly exempted it from both revocation guards — a stolen
 * JWT kept pulling contracts and receipts for the full seven-day `maxAge`
 * after the password behind it was changed. Every entry point authenticates
 * through this module now; nothing outside it should call `auth()`.
 */
export async function requireUserOrNull(): Promise<SessionActor | null> {
  const session = await auth()
  if (!session?.user?.id) return null

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { disabledAt: true, passwordChangedAt: true }
  })
  if (!user || user.disabledAt !== null) return null
  if (sessionOutdatedByPasswordChange(user.passwordChangedAt, session.user.tokenIssuedAt)) {
    return null
  }

  return {
    userId: session.user.id,
    orgId: session.user.orgId,
    role: session.user.role,
    buyerId: session.user.buyerId,
    fullName: session.user.name ?? '',
    email: session.user.email ?? ''
  }
}

export async function requireStaff(): Promise<SessionActor> {
  const actor = await requireUser()
  assertRole(actor, ['ADMIN', 'AGENT'])
  return actor
}

export async function requireAdmin(): Promise<SessionActor> {
  const actor = await requireUser()
  assertRole(actor, ['ADMIN'])
  return actor
}

export async function requireBuyer(): Promise<SessionActor & { buyerId: string }> {
  const actor = await requireUser()
  assertRole(actor, ['BUYER'])
  if (!actor.buyerId) throw new AuthorizationError()
  return { ...actor, buyerId: actor.buyerId }
}
