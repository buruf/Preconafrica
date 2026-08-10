import { redirect } from 'next/navigation'
import { auth } from '@/server/auth'
// db.ts imports nothing from this module (its only import is @prisma/client),
// so this direction cannot cycle.
import { prisma } from '@/server/db'

export type Role = 'ADMIN' | 'AGENT' | 'BUYER'

export interface SessionActor {
  userId: string
  orgId: string
  role: Role
  buyerId: string | null
  fullName: string
  email: string
}

export class AuthorizationError extends Error {
  constructor() {
    // Deliberately vague: the message must not disclose which roles qualify.
    super('You do not have access to this resource.')
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
 * ago. That is checked here against the database on every authenticated
 * request: one indexed primary-key read of a single nullable column, which is
 * a price worth paying to make "deactivate this agent" take effect on their
 * very next navigation rather than up to a week later. `Sale.createdByUserId`
 * is a plain string rather than a relation, so a user row can genuinely be
 * gone; a missing row is treated exactly like a disabled one.
 */
export async function requireUser(): Promise<SessionActor> {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { disabledAt: true }
  })
  if (!user || user.disabledAt !== null) redirect('/login')

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
