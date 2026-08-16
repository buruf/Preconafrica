'use server'

import { redirect } from 'next/navigation'
import { PasswordSchema, confirmationMatches } from '@/domain/password-reset'
import { resetSubmitScopes } from '@/domain/rate-limit'
import {
  RATE_LIMIT_MESSAGE,
  checkRateLimit,
  clientIp,
  recordRateLimitHit
} from '@/server/rate-limit'
import { ServiceError } from '@/server/services/errors'
import { resetPassword } from '@/server/services/passwords'

export async function resetPasswordAction(_prev: string | undefined, formData: FormData) {
  const token = String(formData.get('token') ?? '')
  const password = String(formData.get('password') ?? '')
  const confirmation = String(formData.get('confirmation') ?? '')

  // Both checks are about what the user typed, not about the token, so
  // answering them precisely gives an attacker nothing. They run first so
  // someone who mistypes their confirmation is told so instead of spending
  // their one-use link on a failed submit.
  const parsed = PasswordSchema.safeParse(password)
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Choose a longer password.'
  }
  if (!confirmationMatches(password, confirmation)) {
    return 'The two passwords do not match.'
  }

  /**
   * The token-guessing bound, keyed on the source only.
   *
   * The token cannot be the key: it is the thing being guessed, so every guess
   * would open a fresh counter with a fresh budget and write a row while doing
   * it — a limiter that grows with the attack and limits nothing. The source is
   * the only stable fact about a guess.
   *
   * Counted after the two checks above so a user who mistypes their
   * confirmation does not spend budget on a submission that never reached the
   * token at all, and before `resetPassword` so a refused attempt costs neither
   * the sha256 lookup nor the bcrypt hash behind it.
   */
  const scopes = resetSubmitScopes(clientIp())
  const gate = await checkRateLimit(scopes, new Date())
  if (!gate.allowed) return RATE_LIMIT_MESSAGE
  await recordRateLimitHit(scopes, new Date())

  try {
    await resetPassword(token, password, new Date())
  } catch (error) {
    // The service already collapses every token failure into one message, so
    // there is nothing to differentiate here.
    return error instanceof ServiceError ? error.message : 'Could not reset your password.'
  }

  redirect('/login?reset=1')
}
