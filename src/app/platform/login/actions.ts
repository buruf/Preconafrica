'use server'

import { AuthError } from 'next-auth'
import { signInScopes } from '@/domain/rate-limit'
import { signIn } from '@/server/auth'
import {
  RATE_LIMIT_MESSAGE,
  checkRateLimit,
  clientIp,
  recordRateLimitHit
} from '@/server/rate-limit'

// The same single message as the developer login, for the same reason — and
// with more riding on it. This form guards the account that can create and
// suspend every developer on the platform, so it must not reveal which
// addresses are operators.
const INCORRECT = 'Email or password is incorrect.'

/**
 * Sign-in for a platform operator. Deliberately the developer login's twin:
 * the same throttle, keyed on the same scopes, with the same
 * count-failures-only behaviour — see the long note in
 * `(auth)/login/actions.ts`, which is the canonical explanation.
 *
 * Sharing `signInScopes` means the two doors share one budget per address and
 * per source. That is the correct direction: an attacker who cannot learn
 * which door an address belongs to also cannot get two separate allowances by
 * guessing at both.
 *
 * The only difference is the provider — `'platform'` reads `PlatformUser` and
 * nothing else — and where a success lands.
 */
export async function platformLoginAction(_prev: string | undefined, formData: FormData) {
  const email = String(formData.get('email') ?? '')
  const scopes = signInScopes(email, clientIp())

  const gate = await checkRateLimit(scopes, new Date())
  if (!gate.allowed) return RATE_LIMIT_MESSAGE

  try {
    await signIn('platform', {
      email,
      password: String(formData.get('password') ?? ''),
      redirectTo: '/platform'
    })
  } catch (error) {
    if (error instanceof AuthError) {
      await recordRateLimitHit(scopes, new Date())
      return INCORRECT
    }
    // Next's redirect signal travels this path on success. Rethrown before any
    // counting, so a clean sign-in spends none of the budget.
    throw error
  }
}
