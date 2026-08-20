import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/server/db'
import type { PlatformActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { recordPlatformAudit } from '@/server/audit/platform-record'

/**
 * What a platform operator can do to a developer, which is deliberately very
 * little: bring one into existence, and stop or restart their staff's access.
 *
 * Nothing here reads a developer's buyers, sales or payments. That is a
 * decision, not an omission — the platform runs the tool and is not a party to
 * anyone's sales, so the console reports counts and nothing else. Any future
 * function in this file that selects a buyer's name or an amount of money is
 * changing that promise and should be argued for on its own.
 */

/**
 * Lowercase letters, digits and hyphens. The slug is a tenant identifier that
 * ends up in URLs, so it is held to a shape rather than merely trimmed.
 */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const CreateDeveloperSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(SLUG, 'Use lowercase letters, numbers and hyphens only.'),
  adminFullName: z.string().trim().min(2).max(120),
  adminEmail: z.string().trim().email().max(200)
})

export type CreateDeveloperInput = z.infer<typeof CreateDeveloperSchema>

/**
 * A first password for a developer's admin, generated rather than chosen.
 *
 * base64url of 18 random bytes — 24 characters, 144 bits. It is shown to the
 * operator exactly once, on the screen that created the account, and is stored
 * only as a bcrypt hash. Nobody types this permanently: the developer changes
 * it, and `passwordChangedAt` then revokes any session that predates the
 * change, including one opened with the temporary value.
 */
function temporaryPassword(): string {
  return randomBytes(18).toString('base64url')
}

/**
 * Bring a developer onto the platform: the organisation and the one account
 * that can administer it, created together or not at all.
 *
 * Together matters. An organisation with no admin is unreachable — nobody can
 * sign in to it, add an agent, or create a project — and would have to be
 * repaired by hand in the database, which is the situation this console exists
 * to end. So both writes share a transaction.
 *
 * This replaces editing `prisma/seed.ts` and running it, which was the only
 * way a developer could be added before.
 */
export async function createDeveloper(
  actor: PlatformActor,
  input: CreateDeveloperInput
): Promise<{ orgId: string; temporaryPassword: string }> {
  const parsed = CreateDeveloperSchema.safeParse(input)
  if (!parsed.success) {
    throw new ServiceError(
      parsed.error.issues[0]?.message ?? 'Please check the developer details.',
      'VALIDATION'
    )
  }

  const { name, slug, adminFullName } = parsed.data
  // Lowercased here because the sign-in lookup lowercases what it is given —
  // storing a capitalised address would create an account nobody could use.
  const adminEmail = parsed.data.adminEmail.toLowerCase()

  // Both are unique columns, so the database would refuse these anyway. Checked
  // first so the operator gets a sentence about what to change rather than a
  // constraint violation.
  const slugTaken = await prisma.organization.findFirst({ where: { slug }, select: { id: true } })
  if (slugTaken) {
    throw new ServiceError(`The short name "${slug}" is already in use.`, 'CONFLICT')
  }

  // `User.email` is unique across the whole platform, not per organisation, so
  // this collides with any developer's staff or buyer.
  const emailTaken = await prisma.user.findUnique({
    where: { email: adminEmail },
    select: { id: true }
  })
  if (emailTaken) {
    throw new ServiceError(`${adminEmail} already has an account.`, 'CONFLICT')
  }

  const password = temporaryPassword()
  const passwordHash = await bcrypt.hash(password, 10)

  const orgId = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name, slug } })

    await tx.user.create({
      data: {
        orgId: org.id,
        email: adminEmail,
        fullName: adminFullName,
        passwordHash,
        // Not a parameter. The first account for a new developer is always
        // their ADMIN — an organisation whose only user is an AGENT cannot
        // add staff, upload a logo, or create a project.
        role: 'ADMIN'
      }
    })

    await recordPlatformAudit(tx, actor, {
      action: 'developer.created',
      entityType: 'Organization',
      entityId: org.id,
      entityLabel: org.name,
      // The admin's email, so the log can answer "who did we give the keys
      // to". Never the password, which exists only in the response below.
      context: { slug, adminEmail }
    })

    return org.id
  })

  return { orgId, temporaryPassword: password }
}

/**
 * Stop, or restart, a developer's staff.
 *
 * The effect lives in `requireUser`, which reads `Organization.suspendedAt` on
 * every authenticated request: ADMIN and AGENT sessions stop working on the
 * next navigation, and BUYER sessions carry on. A buyer paying for a flat keeps
 * the contracts and receipts they already hold — the dispute is between the
 * platform and the developer, and is not theirs.
 *
 * Nothing is deleted, here or anywhere: a suspension is reversible by calling
 * this again with `false`, and the developer's data is untouched throughout.
 */
export async function setDeveloperSuspended(
  actor: PlatformActor,
  orgId: string,
  suspended: boolean
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const org = await tx.organization.update({
      where: { id: orgId },
      data: { suspendedAt: suspended ? new Date() : null },
      select: { id: true, name: true }
    })

    await recordPlatformAudit(tx, actor, {
      action: suspended ? 'developer.suspended' : 'developer.unsuspended',
      entityType: 'Organization',
      entityId: org.id,
      entityLabel: org.name
    })
  })
}
