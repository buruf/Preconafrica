import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { constraintTargetIncludes } from '@/server/services/units'
import { ImageUrlField } from '@/server/services/media'
import { deleteReplacedBlobs } from '@/server/media/blob'
import { recordAudit } from '@/server/audit/record'
import { diffValues, image } from '@/domain/audit'

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
    // The create and its audit entry commit together: granting somebody access
    // to a system of record, with no record of who granted it, is precisely the
    // gap this log closes. The transaction changes nothing a caller can see —
    // the same `{ userId }` comes back, and a P2002 still escapes to the catch
    // below, where it is translated exactly as before.
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
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

      await recordAudit(tx, actor, {
        action: 'user.agent_added',
        entityType: 'User',
        entityId: created.id,
        entityLabel: created.fullName
      })

      return created
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
    select: { id: true, fullName: true, email: true, role: true, createdAt: true, disabledAt: true }
  })

  // `active` is derived from `disabledAt`, which is the same field
  // `requireUser` checks on every authenticated request — so what this list
  // shows and what the session guard actually enforces can never disagree.
  // The password hash is no longer selected at all, which beats selecting it
  // and trusting the page not to render it. The query's
  // `role: { in: ['ADMIN', 'AGENT'] }` filter guarantees BUYER never shows up
  // here, but Prisma's generated type is the full UserRole enum, so the
  // narrower TeamMember role needs an explicit cast.
  return users.map(({ disabledAt, role, ...user }) => ({
    ...user,
    role: role as 'ADMIN' | 'AGENT',
    active: disabledAt === null
  }))
}

/**
 * The organisation's own record, as far as anything an admin can edit goes —
 * which today is the logo that heads every invoice.
 *
 * The team page is the only org-level admin surface there is, so this lives
 * beside it rather than behind a settings section nobody would find. ADMIN only:
 * the logo appears on documents sent to buyers, so it is the organisation's
 * letterhead, not a per-agent preference.
 */
export interface OrganizationProfile {
  name: string
  logoUrl: string | null
}

export async function getOrganization(actor: SessionActor): Promise<OrganizationProfile> {
  assertRole(actor, ['ADMIN'])
  const org = await prisma.organization.findUnique({
    where: { id: actor.orgId },
    select: { name: true, logoUrl: true }
  })
  if (!org) throw new ServiceError('Organisation not found', 'NOT_FOUND')
  return org
}

/**
 * The organisation's display name, for anyone who belongs to it.
 *
 * `getOrganization` above is ADMIN-only because it carries the letterhead logo,
 * which is an editable setting. The *name* is not a setting — it heads the staff
 * home screen and appears on every buyer's profile, so an agent and a buyer both
 * have to be able to read it, and neither may call the admin function to do so.
 *
 * There is no assertRole because there is nothing to authorise: the lookup is
 * keyed by `actor.orgId` from the session, so the only organisation any caller
 * can name is the one they are already inside. No parameter here could point at
 * another tenant.
 */
export async function getOrganizationName(actor: SessionActor): Promise<string> {
  const org = await prisma.organization.findUnique({
    where: { id: actor.orgId },
    select: { name: true }
  })
  if (!org) throw new ServiceError('Organisation not found', 'NOT_FOUND')
  return org.name
}

export const UpdateOrganizationSchema = z.object({ logoUrl: ImageUrlField })

export type UpdateOrganizationInput = z.infer<typeof UpdateOrganizationSchema>

export async function updateOrganizationLogo(
  actor: SessionActor,
  input: UpdateOrganizationInput
) {
  assertRole(actor, ['ADMIN'])
  // Keyed by the session's orgId, never by anything a form sent — there is no
  // parameter here that could point at another tenant.
  const before = await prisma.organization.findUnique({
    where: { id: actor.orgId },
    select: { logoUrl: true }
  })

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: actor.orgId },
      data: { logoUrl: input.logoUrl }
    })

    // The logo is the letterhead on every invoice and receipt a buyer receives,
    // so changing it changes what the organisation looks like to its customers.
    // Only recorded when it actually moved — an admin who opens the form and
    // saves it unchanged has not done anything.
    const changes = diffValues(
      { logoUrl: image(before?.logoUrl) },
      { logoUrl: image(input.logoUrl) }
    )
    if (changes.length > 0) {
      await recordAudit(tx, actor, {
        action: 'org.updated',
        entityType: 'Organization',
        entityId: actor.orgId,
        changes
      })
    }
  })

  // The replaced mark, deleted only once the row has stopped pointing at it,
  // and only if it was this org's own upload. A logo an admin pasted from their
  // corporate site is somebody else's asset and is never touched.
  await deleteReplacedBlobs([before?.logoUrl], [input.logoUrl], actor.orgId)
}

export async function deactivateAgent(actor: SessionActor, userId: string) {
  assertRole(actor, ['ADMIN'])
  if (userId === actor.userId) throw new ServiceError('You cannot remove your own account')

  const user = await prisma.user.findFirst({
    where: { id: userId, orgId: actor.orgId, role: 'AGENT' }
  })
  if (!user) throw new ServiceError('Agent not found', 'NOT_FOUND')

  // Sales reference createdByUserId/recordedByUserId, so the row is kept.
  //
  // Two writes, one intent:
  //   - `disabledAt` is what actually revokes access. `requireUser` reads it on
  //     every authenticated request, so an agent holding a valid JWT is locked
  //     out on their very next navigation rather than up to a week later when
  //     the token expires.
  //   - the hash overwrite stays as defence in depth: it blocks the login form
  //     even if a future change stops consulting `disabledAt`. The replacement
  //     is a value no input can produce, so bcrypt.compare against it always
  //     resolves false and never throws.
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { disabledAt: new Date(), passwordHash: `disabled:${randomUUID()}` }
    })

    // Revoking access is as much a change to who can act as granting it. The
    // hash overwrite is deliberately not in the diff: it is a defence-in-depth
    // detail, not a fact about the account anybody needs read back, and a log
    // that mentions password hashes invites somebody to record one.
    await recordAudit(tx, actor, {
      action: 'user.agent_deactivated',
      entityType: 'User',
      entityId: userId,
      entityLabel: user.fullName,
      changes: [{ field: 'status', from: { kind: 'enum', value: 'ACTIVE' }, to: { kind: 'enum', value: 'DEACTIVATED' } }]
    })
  })
}
