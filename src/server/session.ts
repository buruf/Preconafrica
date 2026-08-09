import { redirect } from 'next/navigation'
import { auth } from '@/server/auth'

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

export async function requireUser(): Promise<SessionActor> {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

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
