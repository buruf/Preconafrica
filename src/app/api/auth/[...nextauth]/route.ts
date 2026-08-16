import type { NextRequest } from 'next/server'
import {
  RATE_LIMIT_MESSAGE,
  clientIpFromForwardedFor,
  signInScopes
} from '@/domain/rate-limit'
import { handlers } from '@/server/auth'
import { checkRateLimit, recordRateLimitHit } from '@/server/rate-limit'

export const runtime = 'nodejs'

export const GET = handlers.GET

/**
 * The credentials callback, throttled on the way in.
 *
 * `loginAction` guards the form, but the form is not the only way to reach the
 * provider: Auth.js's server-action `signIn` calls the core in process, while
 * anything else — curl, a script, a replayed CSRF token — posts here instead.
 * Guarding only the action would have produced a throttle that inconveniences
 * honest users mistyping their password and does nothing at all to the attacker
 * it was built for. Both paths key the same scopes, so they share one budget.
 *
 * Nothing about how credentials are verified changes here: the request is
 * passed to Auth.js untouched, and the only additions are a read before it and
 * a counter after it.
 */
export async function POST(request: NextRequest) {
  const isCredentialsCallback = new URL(request.url).pathname.endsWith('/callback/credentials')
  if (!isCredentialsCallback) return handlers.POST(request)

  const ip = clientIpFromForwardedFor(request.headers.get('x-forwarded-for'))

  // The body is read from a clone so the original stream reaches Auth.js
  // intact. A body that will not parse is not a reason to refuse — it is
  // simply an attempt with no identifier, which the source-scoped counter
  // still sees.
  let email = ''
  try {
    email = String((await request.clone().formData()).get('email') ?? '')
  } catch {
    email = ''
  }

  const scopes = signInScopes(email, ip)

  const gate = await checkRateLimit(scopes, new Date())
  if (!gate.allowed) {
    // A plain sentence, and the same one the form shows. The status code is
    // there for the machine; the body is there for whoever reads it.
    return new Response(RATE_LIMIT_MESSAGE, {
      status: 429,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': String(Math.ceil(gate.retryAfterMs / 1000))
      }
    })
  }

  const response = await handlers.POST(request)

  // Auth.js answers this callback with a redirect either way: to the requested
  // callback URL on success, and to an error page carrying `error=` on failure.
  // Anything else (a thrown 500, an unexpected shape) is counted as a failure
  // too — an ambiguous outcome should cost budget rather than supply an
  // unlimited number of free attempts.
  const location = response.headers.get('location') ?? ''
  const succeeded = response.status < 400 && location !== '' && !location.includes('error=')
  if (!succeeded) await recordRateLimitHit(scopes, new Date())

  return response
}
