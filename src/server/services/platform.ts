import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/server/db'
import type { PlatformActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { recordPlatformAudit } from '@/server/audit/platform-record'
import { PasswordSchema } from '@/domain/password-reset'

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

/**
 * An operator changing their own password.
 *
 * The developer-facing `changePassword` is the model, and every rule it holds
 * to is held to here — this account is strictly more powerful, so none of them
 * could reasonably be relaxed:
 *
 *   - the current password must be proved, so a borrowed session cannot lock
 *     the real operator out;
 *   - the new one must differ, because re-setting the same password would
 *     report success while revoking every session, which is the worst possible
 *     answer to "did anything happen?";
 *   - `passwordChangedAt` is stamped, and that is what actually revokes the old
 *     sessions — `requirePlatformAdminOrNull` compares it against the token's
 *     `authTime` on every request.
 *
 * That last rule is the whole reason this exists. The first password an
 * operator ever has is a temporary one, generated by
 * `scripts/create-platform-admin.mjs` and printed to a terminal, so the moment
 * it is replaced, anything opened with it has to stop working.
 *
 * There is deliberately no reset-by-email counterpart. The recovery path for
 * this account is re-running that script, which requires database access —
 * an emailed link that can seize control of every developer on the platform is
 * a wider door than this needs.
 */
export async function changePlatformPassword(
  actor: PlatformActor,
  currentPassword: string,
  newPassword: string,
  now: Date
): Promise<void> {
  const parsed = PasswordSchema.safeParse(newPassword)
  if (!parsed.success) {
    throw new ServiceError(parsed.error.issues[0].message, 'VALIDATION')
  }

  const admin = await prisma.platformUser.findUnique({
    where: { id: actor.userId },
    select: { passwordHash: true, disabledAt: true, fullName: true }
  })
  if (!admin || admin.disabledAt !== null) {
    throw new ServiceError('Account not found.', 'NOT_FOUND')
  }

  const ok = await bcrypt.compare(currentPassword, admin.passwordHash)
  if (!ok) {
    throw new ServiceError('Your current password is incorrect.', 'VALIDATION')
  }

  if (currentPassword === newPassword) {
    throw new ServiceError(
      'Your new password must be different from your current one.',
      'VALIDATION'
    )
  }

  const passwordHash = await bcrypt.hash(parsed.data, 10)

  await prisma.$transaction(async (tx) => {
    await tx.platformUser.update({
      where: { id: actor.userId },
      data: { passwordHash, passwordChangedAt: now }
    })

    // That it happened, and nothing about either password.
    await recordPlatformAudit(tx, actor, {
      action: 'operator.password_changed',
      entityType: 'PlatformUser',
      entityId: actor.userId,
      entityLabel: admin.fullName
    })
  })
}

/**
 * Remove a developer that has nothing in it.
 *
 * This exists for exactly one situation: a mistyped developer, created a minute
 * ago, with no projects, no buyers and no sales. The short name is fixed at
 * creation, so before this a typo was permanent and the honest answer was "live
 * with it".
 *
 * **Empty is checked against the database, not asserted by the caller.** Five
 * counts, all of which must be zero. Projects, buyers and sales are the obvious
 * three; payments and documents are counted in their own right rather than
 * inferred from "no sales, therefore no payments". That inference happens to be
 * true today — `Sale` is `onDelete: Restrict` from both — but this check must
 * not depend on that staying true, because being wrong here destroys money
 * history permanently.
 *
 * Staff accounts are not counted and do not block: a developer always has at
 * least the admin created alongside it, and `Organization.users` cascades, so
 * deleting an empty developer takes exactly the account that was made for it.
 * That cascade is also precisely why the emptiness rule has to be strict.
 *
 * Anything with real data is **suspended, never deleted**. There is no force
 * flag and should not be one: a system of record that can be made to forget a
 * sale is not a system of record.
 */
export async function deleteDeveloper(actor: PlatformActor, orgId: string): Promise<void> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      _count: { select: { projects: true, buyers: true, sales: true, payments: true, documents: true } }
    }
  })
  if (!org) throw new ServiceError('That developer was not found.', 'NOT_FOUND')

  const holdings: Array<[string, number]> = [
    ['project', org._count.projects],
    ['buyer', org._count.buyers],
    ['sale', org._count.sales],
    ['payment', org._count.payments],
    ['document', org._count.documents]
  ]
  const blocking = holdings.filter(([, count]) => count > 0)

  if (blocking.length > 0) {
    // Names what is in the way, so the operator knows whether they picked the
    // wrong developer or genuinely meant to suspend one.
    const what = blocking
      .map(([noun, count]) => `${count} ${noun}${count === 1 ? '' : 's'}`)
      .join(', ')
    throw new ServiceError(
      `${org.name} is not empty — it has ${what}. Suspend it instead; nothing is ever deleted once a developer has data.`,
      'CONFLICT'
    )
  }

  await prisma.$transaction(async (tx) => {
    // Recorded before the delete, in the same transaction. `PlatformAuditEntry`
    // holds no foreign key to `Organization` precisely so the record outlives
    // the row — the log has to be able to say what is gone.
    await recordPlatformAudit(tx, actor, {
      action: 'developer.deleted',
      entityType: 'Organization',
      entityId: org.id,
      entityLabel: org.name
    })

    await tx.organization.delete({ where: { id: org.id } })
  })
}
