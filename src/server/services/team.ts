import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { constraintTargetIncludes } from '@/server/services/units'

export const CreateAgentSchema = z.object({
  fullName: z.string().trim().min(2, 'Name is required').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(8, 'Use at least 8 characters')
})

export type CreateAgentInput = z.infer<typeof CreateAgentSchema>

const DUPLICATE_EMAIL_MESSAGE = 'That email is already in use.'

export async function createAgent(actor: SessionActor, input: CreateAgentInput) {
  assertRole(actor, ['ADMIN'])

  // Cheap pre-check: gives the common case (no race) a clean answer without
  // burning a failed insert. It is not sufficient on its own — two concurrent
  // adds for the same email can both pass it, so the create below still has
  // to guard against the actual insert losing that race (see registerBuyer).
  const existing = await prisma.user.findUnique({ where: { email: input.email } })
  if (existing) throw new ServiceError(DUPLICATE_EMAIL_MESSAGE, 'CONFLICT')

  const passwordHash = await bcrypt.hash(input.password, 10)

  try {
    const user = await prisma.user.create({
      data: {
        // The agent joins the admin's organisation, taken from the session —
        // never from the form, or an admin could plant a user in another tenant.
        orgId: actor.orgId,
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        role: 'AGENT'
      }
    })

    return { userId: user.id }
  } catch (error) {
    // The loser of a concurrent double-add lands here: the pre-check above
    // passed for both, but only one `user.create` can win the unique-email
    // constraint. Confirm the violated constraint actually involves `email`
    // before claiming a duplicate-email conflict — a P2002 on some other
    // constraint must not be mislabelled.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      constraintTargetIncludes(error.meta?.target, 'email')
    ) {
      throw new ServiceError(DUPLICATE_EMAIL_MESSAGE, 'CONFLICT')
    }
    throw error
  }
}

export interface TeamMember {
  id: string
  fullName: string
  email: string
  role: 'ADMIN' | 'AGENT'
  createdAt: Date
  active: boolean
}

export async function listTeam(actor: SessionActor): Promise<TeamMember[]> {
  assertRole(actor, ['ADMIN'])
  const users = await prisma.user.findMany({
    where: { orgId: actor.orgId, role: { in: ['ADMIN', 'AGENT'] } },
    orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
    select: { id: true, fullName: true, email: true, role: true, createdAt: true, passwordHash: true }
  })

  // The hash itself never leaves this function — only the derived boolean
  // does, so the page can never accidentally render or leak it. The query's
  // `role: { in: ['ADMIN', 'AGENT'] } }` filter guarantees BUYER never shows
  // up here, but Prisma's generated type is the full UserRole enum, so the
  // narrower TeamMember role needs an explicit cast.
  return users.map(({ passwordHash, role, ...user }) => ({
    ...user,
    role: role as 'ADMIN' | 'AGENT',
    active: !passwordHash.startsWith('disabled:')
  }))
}

export async function deactivateAgent(actor: SessionActor, userId: string) {
  assertRole(actor, ['ADMIN'])
  if (userId === actor.userId) throw new ServiceError('You cannot remove your own account')

  const user = await prisma.user.findFirst({
    where: { id: userId, orgId: actor.orgId, role: 'AGENT' }
  })
  if (!user) throw new ServiceError('Agent not found', 'NOT_FOUND')

  // Sales reference createdByUserId/recordedByUserId, so the row is kept and
  // the login is disabled by replacing the hash with one no input can
  // produce — bcrypt.compare against it always resolves false, never throws.
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: `disabled:${randomUUID()}` }
  })
}
