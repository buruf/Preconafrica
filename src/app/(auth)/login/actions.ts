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

// One message for both wrong-email and wrong-password, so the form cannot be
// used to discover which addresses are registered.
const INCORRECT = 'Email or password is incorrect.'

/**
 * The throttle sits around the credentials provider, not inside it. Nothing
 * about how a password is verified changes: `signIn` still runs the same
 * `authorize`, the same lookup and the same bcrypt comparison. What changes is
 * that a caller who has already burned the budget never reaches them.
 *
 * Two properties are deliberate, and both are about not undoing the
 * enumeration resistance the rest of this flow is built on:
 *
 *   1. The counters are keyed on the email as typed and on the source address,
 *      and neither is ever looked up. A registered address and a made-up one
 *      therefore reach the refusal after exactly the same number of attempts
 *      and show exactly the same sentence. A per-account counter that only
 *      existed for real accounts would have made the throttle itself the
 *      oracle the generic message was written to prevent.
 *   2. The check happens before `signIn`, so a refused attempt does no bcrypt
 *      work — which also removes the timing difference a post-check would have
 *      introduced between "throttled" (fast) and "verified and rejected"
 *      (slow).
 *
 * Only failures are counted. A correct password leaves `signIn` by throwing the
 * redirect, so the recording line below is never reached on success — a user
 * who signs in cleanly spends none of their budget.
 *
 * The direct `POST /api/auth/callback/credentials` path does not come through
 * here (server-action `signIn` calls Auth.js in process rather than over HTTP),
 * so that route carries the same guard of its own. Both use these same scopes,
 * so the two paths share one budget.
 */
export async function loginAction(_prev: string | undefined, formData: FormData) {
  const email = String(formData.get('email') ?? '')
  const scopes = signInScopes(email, clientIp())

  const gate = await checkRateLimit(scopes, new Date())
  if (!gate.allowed) return RATE_LIMIT_MESSAGE

  try {
    await signIn('credentials', {
      email,
      password: String(formData.get('password') ?? ''),
      redirectTo: '/'
    })
  } catch (error) {
    if (error instanceof AuthError) {
      await recordRateLimitHit(scopes, new Date())
      return INCORRECT
    }
    // Includes Next's redirect signal, which is how a *successful* sign-in
    // leaves this function. Rethrowing before any counting is what makes
    // "successful sign-ins do not count" true rather than merely intended.
    throw error
  }
}
