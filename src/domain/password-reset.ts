import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * The rules behind password reset, with nothing that touches a database, a
 * clock or a network. `node:crypto`'s `createHash` is a pure function of its
 * input — same bytes in, same bytes out, no I/O and no ambient state — so it
 * belongs here rather than in the service, and the domain-purity guard (which
 * forbids `@prisma/client`, `@/server`, `next/`, `node:fs` and `resend`)
 * agrees. Every function below takes `now` from its caller for the same reason
 * the rest of the domain does.
 */

/**
 * How long a reset link stays usable. One hour is the whole trade: long enough
 * to survive a slow mail relay and a distracted user, short enough that a link
 * sitting in a mailbox someone else later reads is usually already dead.
 */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000

/**
 * The stored form of a reset token. The raw token goes in the email; this hash
 * goes in the database. sha256 with no salt and no work factor is right here
 * and would be wrong for a password: the input is 32 bytes of CSPRNG output,
 * so there is no dictionary to attack and nothing a slow KDF would buy — while
 * the lookup has to be by exact hash, which a per-row salt would make
 * impossible.
 */
export function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/**
 * A token is usable only while it is unspent and unexpired. Exact expiry
 * counts as expired: at `expiresAt` the hour is over.
 */
export function isResetTokenUsable(
  token: { expiresAt: Date; usedAt: Date | null },
  now: Date
): boolean {
  if (token.usedAt !== null) return false
  return token.expiresAt.getTime() > now.getTime()
}

/**
 * Whether a session predates the account's last password change and must
 * therefore be thrown away.
 *
 * Two clocks meet here and they do not have the same resolution: a JWT's `iat`
 * is whole seconds, `passwordChangedAt` is a millisecond-precision timestamp.
 * Comparing them naively leaves a one-second window in which a token issued
 * *during* the second a password changed looks newer than the change and
 * survives it — precisely the token an attacker who is racing the reset would
 * hold. So the change time is floored to seconds and compared with `>=`: a
 * change in the same second as issuance counts as invalidating. The cost of
 * being wrong in this direction is that someone who signed in in the same
 * second they changed their password signs in again; the cost of being wrong
 * in the other direction is a live session the reset was supposed to kill.
 *
 * A missing `iat` is treated the same way, and for the same reason: if we
 * cannot tell when the session was issued, we cannot tell that it postdates
 * the change, so it goes. (Auth.js always stamps `iat`; this is the branch
 * that keeps a future change to that from silently disabling revocation.)
 */
export function sessionOutdatedByPasswordChange(
  passwordChangedAt: Date | null,
  tokenIssuedAtSeconds: number | undefined
): boolean {
  if (passwordChangedAt === null) return false
  if (tokenIssuedAtSeconds === undefined || !Number.isFinite(tokenIssuedAtSeconds)) return true

  const changedAtSeconds = Math.floor(passwordChangedAt.getTime() / 1000)
  return changedAtSeconds >= tokenIssuedAtSeconds
}

/**
 * The same rule `CreateAgentSchema` and buyer registration already apply, so
 * a password chosen at a reset cannot be weaker than one chosen at signup.
 * Deliberately not a new, stricter policy: inventing one here would mean the
 * app enforced two different definitions of "acceptable password" depending
 * on which form you happened to use.
 */
export const PasswordSchema = z.string().min(8, 'Use at least 8 characters')

/**
 * The confirm-field rule, kept here rather than inline in a form so it is one
 * testable statement instead of two hand-written comparisons that can drift.
 * Exact string equality — no trimming, because a trailing space is part of a
 * password and silently eating it would let someone set a password they can
 * never type again.
 */
export function confirmationMatches(password: string, confirmation: string): boolean {
  return password === confirmation
}
