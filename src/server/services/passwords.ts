import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '@/server/db'
import { ServiceError } from '@/server/services/errors'
import {
  PasswordSchema,
  RESET_TOKEN_TTL_MS,
  hashResetToken,
  isResetTokenUsable
} from '@/domain/password-reset'
import { recordAudit } from '@/server/audit/record'

/**
 * One message for every way a reset link can fail — unknown, expired, already
 * spent, or belonging to a deactivated account. Distinguishing them would turn
 * /reset-password into an oracle: "expired" confirms the token was real, and
 * "this account is deactivated" confirms both the account and its state to
 * anyone holding an old link. There is nothing the legitimate user does
 * differently in any of those cases anyway — they ask for a new link.
 */
const INVALID_TOKEN_MESSAGE = 'This reset link is invalid or has expired.'

/**
 * How long a caller must wait before a second link is issued. This is the
 * mail-bomb guard: without it, anyone who knows an address can have this app
 * mail its owner as fast as they can submit the form. It is deliberately
 * DB-backed rather than in-memory — an in-memory counter resets on every
 * serverless cold start and is per-instance, which is no throttle at all —
 * and deliberately not Redis, which this app does not run.
 */
const RESET_THROTTLE_MS = 60 * 1000

/**
 * The base for the link in the email. Absolute, because it is clicked from a
 * mail client that has no origin to resolve against.
 *
 * Both spellings are read. `NEXTAUTH_URL` is what this app has always set and
 * what is configured in Vercel today; `AUTH_URL` is what next-auth v5 prefers,
 * and what a fresh deployment is likelier to be given. Reading only one of
 * them means an environment that sets the other mails relative links to
 * everybody — a total failure of the reset flow that no test catches, because
 * the variable is present under the name the tests use.
 *
 * A missing value degrades to a relative path rather than throwing, and that
 * is not laziness: throwing here would fail only for addresses that exist and
 * are not throttled, which hands an enumeration oracle to anyone who finds the
 * app misconfigured. A broken link in an email is a bug; a 500 that means
 * "yes, that account exists" is a vulnerability.
 */
function resetUrlFor(rawToken: string): string {
  const base = (process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? '').replace(/\/+$/, '')
  return `${base}/reset-password?token=${rawToken}`
}

export interface PasswordResetRequest {
  /**
   * The absolute link to mail, or null when no link is to be sent — unknown
   * address, deactivated account, or throttled. The caller cannot tell which,
   * and must render the same thing either way.
   */
  resetUrl: string | null
  /**
   * The recipient's name, for the greeting in the email the caller renders.
   * Null exactly when `resetUrl` is null. It never reaches the browser: the
   * page's confirmation text is a constant, so carrying it here discloses
   * nothing to the person who submitted the form.
   */
  fullName: string | null
}

/**
 * Start a reset. Never throws for a missing user and never reports one —
 * the whole function is written so that the caller has nothing to leak.
 */
export async function requestPasswordReset(
  email: string,
  now: Date
): Promise<PasswordResetRequest> {
  const normalised = email.trim().toLowerCase()

  const user = await prisma.user.findUnique({
    where: { email: normalised },
    select: { id: true, fullName: true, disabledAt: true }
  })

  // No such address: resolve exactly as the success path does. Nothing about
  // the shape of this return distinguishes it from a throttled real user.
  if (!user) return { resetUrl: null, fullName: null }

  // A deactivated account must not be able to reset its way back in. The
  // login form already refuses it (requireUser and the hash overwrite in
  // deactivateAgent), and a reset link that set a fresh, working hash would
  // be a way around exactly one of those two — so it is refused here too,
  // silently, for the same non-disclosure reason.
  if (user.disabledAt !== null) return { resetUrl: null, fullName: null }

  // 32 bytes of CSPRNG output: 256 bits of entropy, so the token cannot be
  // guessed or brute-forced against the unique index. base64url because it
  // travels in a query string and must survive being copied out of an email
  // client without percent-encoding. Generated before the transaction because
  // it is pure computation; it is simply discarded if the throttle wins.
  const rawToken = randomBytes(32).toString('base64url')

  const issued = await prisma.$transaction(async (tx) => {
    // Serialise every concurrent request for *this* user, and nothing else.
    // Read-then-write with no lock is a race, and this one has teeth: two
    // submissions a few milliseconds apart both saw an empty throttle window,
    // both mailed a link, and both created a row — leaving two live tokens for
    // one account, which is exactly what the schema comment on
    // `PasswordResetToken.usedAt` claims cannot happen. (The retirement sweep
    // below does not save it: each transaction retires the rows it can see,
    // and neither can see the other's uncommitted insert.)
    //
    // A transaction-scoped advisory lock is the cheap fix: it needs no table,
    // it is released on commit or rollback with no unlock call to forget, and
    // `hashtext` turns the cuid into the bigint the lock space wants. A hash
    // collision between two different user ids costs one of them a brief wait
    // and nothing else.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`

    // Re-checked *inside* the lock. This is the read that decides; doing it
    // outside would be the same race with extra steps.
    const recent = await tx.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: now },
        createdAt: { gt: new Date(now.getTime() - RESET_THROTTLE_MS) }
      },
      select: { id: true }
    })
    if (recent) return false

    // Asking for a new link retires the old ones. Two live links for one
    // account is one more than the user believes they have, and the older
    // one is the likelier to be sitting somewhere it should not be.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now }
    })

    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        // Only the hash is persisted; `rawToken` never leaves this process
        // except inside the link the caller mails.
        tokenHash: hashResetToken(rawToken),
        expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
        createdAt: now
      }
    })

    return true
  })

  // Throttled, and reported exactly as the unknown-address path is.
  if (!issued) return { resetUrl: null, fullName: null }

  return { resetUrl: resetUrlFor(rawToken), fullName: user.fullName }
}

/**
 * Spend a reset link and set the new password.
 *
 * Every rejection path throws the same message; see INVALID_TOKEN_MESSAGE.
 */
export async function resetPassword(
  rawToken: string,
  newPassword: string,
  now: Date
): Promise<void> {
  // Checked before the token, and it is safe to answer honestly: whether a
  // password is eight characters long is something the person typing it
  // already knows, so this message reveals nothing about the token.
  const parsed = PasswordSchema.safeParse(newPassword)
  if (!parsed.success) {
    throw new ServiceError(parsed.error.issues[0].message, 'VALIDATION')
  }

  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(rawToken) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      usedAt: true,
      // `orgId`, `fullName` and `role` are read for the audit entry only. A
      // reset has no session, so the actor cannot come from one — it is the
      // account the token belongs to, which this row already identifies. Three
      // more columns on a lookup that was already happening; nothing about what
      // this function accepts or refuses changes.
      user: { select: { disabledAt: true, orgId: true, fullName: true, role: true } }
    }
  })

  if (!token || !isResetTokenUsable(token, now) || token.user.disabledAt !== null) {
    throw new ServiceError(INVALID_TOKEN_MESSAGE, 'VALIDATION')
  }

  const passwordHash = await bcrypt.hash(parsed.data, 10)

  await prisma.$transaction(async (tx) => {
    // Claim the token inside the transaction with `usedAt: null` still in the
    // where-clause, and check the row count. The read above is not enough on
    // its own: two submissions of the same link can both pass it, and only
    // this conditional update can decide which one actually spends the token.
    // Without it, "single use" would hold only when nobody replays quickly.
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: now }
    })
    if (claimed.count !== 1) {
      throw new ServiceError(INVALID_TOKEN_MESSAGE, 'VALIDATION')
    }

    // Any other outstanding link for this account dies with it. Resetting is
    // the response to a suspected compromise, so leaving a second live link
    // behind would defeat the point of the first.
    await tx.passwordResetToken.updateMany({
      where: { userId: token.userId, usedAt: null },
      data: { usedAt: now }
    })

    // `passwordChangedAt` is the half that revokes sessions; the hash alone
    // only closes the login form. They are written together, in one
    // transaction, because a state where one landed and the other did not is
    // either a lockout or a live session that should be dead.
    //
    // Conditional on the account still being active, exactly as the token
    // claim above is conditional on the token still being unspent, and for the
    // same reason: the deactivation check ran outside this transaction, and an
    // admin who deactivates the account in the seconds between that read and
    // this write would otherwise be handing it a fresh working password on the
    // way out. `updateMany` because `update` cannot take a non-unique filter.
    // The count is checked, and a miss throws the one generic message — a
    // deactivated account must not learn that it is deactivated from here.
    const written = await tx.user.updateMany({
      where: { id: token.userId, disabledAt: null },
      data: { passwordHash, passwordChangedAt: now }
    })
    if (written.count !== 1) {
      throw new ServiceError(INVALID_TOKEN_MESSAGE, 'VALIDATION')
    }

    // Recorded after the write succeeded and inside the same transaction, so
    // the log agrees with the password: a refused reset (spent token,
    // deactivated account) has thrown above and leaves no entry, and a
    // successful one cannot commit without this row.
    //
    // The actor is the account itself. Nobody else could have done this —
    // holding the link is the whole proof — and attributing it to a person is
    // what makes "who reset that password, and when" answerable. Nothing about
    // the token, the link or the password is recorded: the entry says a reset
    // happened, which is the fact worth keeping.
    await recordAudit(
      tx,
      {
        userId: token.userId,
        orgId: token.user.orgId,
        role: token.user.role,
        fullName: token.user.fullName
      },
      {
        action: 'user.password_reset',
        entityType: 'User',
        entityId: token.userId,
        entityLabel: token.user.fullName
      }
    )
  })
}

/**
 * Signed-in self-service change. Unlike a reset this proves nothing about
 * email control, so it has to prove knowledge of the current password.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  now: Date
): Promise<void> {
  const parsed = PasswordSchema.safeParse(newPassword)
  if (!parsed.success) {
    throw new ServiceError(parsed.error.issues[0].message, 'VALIDATION')
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    // The last three are for the audit entry — same reason as `resetPassword`
    // above: this function is handed a user id, not a session, so the actor has
    // to come from the row.
    select: { passwordHash: true, disabledAt: true, orgId: true, fullName: true, role: true }
  })
  if (!user || user.disabledAt !== null) {
    throw new ServiceError('Account not found.', 'NOT_FOUND')
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash)
  if (!ok) {
    throw new ServiceError('Your current password is incorrect.', 'VALIDATION')
  }

  // Re-setting the same password is refused rather than quietly accepted. It
  // would otherwise report success while revoking every one of the user's
  // sessions — the worst possible answer to "did anything happen?" — and it
  // is nearly always someone who meant to type something new.
  if (currentPassword === newPassword) {
    throw new ServiceError('Your new password must be different from your current one.', 'VALIDATION')
  }

  const passwordHash = await bcrypt.hash(parsed.data, 10)

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash, passwordChangedAt: now }
    })

    // A user who changes their password because they suspect trouble should
    // not leave a reset link someone else requested still standing.
    await tx.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now }
    })

    // The actor is the user, because a self-service change is the one password
    // operation that proves who did it — it required the current password. The
    // entry records that it happened and nothing about either password.
    await recordAudit(
      tx,
      { userId, orgId: user.orgId, role: user.role, fullName: user.fullName },
      {
        action: 'user.password_changed',
        entityType: 'User',
        entityId: userId,
        entityLabel: user.fullName
      }
    )
  })
}

/**
 * Delete reset tokens that can never be used again.
 *
 * Nothing else removes these rows. Every request creates one and every reset,
 * supersession or password change only *marks* one — so the table grew
 * monotonically, one row per request, forever. That is not a security hole on
 * its own (a spent or expired row grants nothing, and only a sha256 is stored),
 * but it is an index that never stops growing and a pile of records about who
 * asked for a reset and when, kept for no reason anybody chose.
 *
 * "Dead" is the exact complement of what `isResetTokenUsable` accepts: spent
 * (`usedAt` set) or past its expiry. A live token is never touched, and
 * deleting a dead one changes no answer — `resetPassword` looks a missing row
 * and an unusable row up to the same generic refusal.
 */
export async function purgeDeadResetTokens(now: Date): Promise<number> {
  const { count } = await prisma.passwordResetToken.deleteMany({
    where: { OR: [{ usedAt: { not: null } }, { expiresAt: { lte: now } }] }
  })
  return count
}
