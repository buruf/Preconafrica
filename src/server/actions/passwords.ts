'use server'

import { PasswordSchema, confirmationMatches } from '@/domain/password-reset'
import { signOut } from '@/server/auth'
import { requireUser } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { changePassword } from '@/server/services/passwords'

/**
 * Shared by the staff and buyer change-password pages, which is why it lives
 * here rather than in a route's own `actions.ts` next to one of them: the two
 * pages differ only in which shell they hang from, and duplicating a
 * security-sensitive action across route groups is exactly how two copies
 * later stop agreeing about what they enforce.
 *
 * It calls `requireUser()` itself. The pages do too — that is the codebase's
 * rule and it stays — but a server action is its own entry point, reachable by
 * POST without ever rendering the page that hosts it, so a guard on the page
 * alone would guard nothing here.
 */
export async function changePasswordAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireUser()

  const currentPassword = String(formData.get('currentPassword') ?? '')
  const password = String(formData.get('password') ?? '')
  const confirmation = String(formData.get('confirmation') ?? '')

  const parsed = PasswordSchema.safeParse(password)
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Choose a longer password.'
  }
  if (!confirmationMatches(password, confirmation)) {
    return 'The two passwords do not match.'
  }

  try {
    // The user id comes from the session, never the form — otherwise this
    // would be a "change anyone's password" endpoint for anyone signed in.
    await changePassword(actor.userId, currentPassword, password, new Date())
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not change your password.'
  }

  // Their own session is already dead — `passwordChangedAt` now postdates the
  // JWT they are holding, so the very next navigation would bounce them to
  // /login with no explanation. Signing out here makes that deliberate and
  // lands them on a page that says what happened, instead of what would
  // otherwise look like being logged out at random. Outside the try because
  // signOut redirects by throwing.
  await signOut({ redirectTo: '/login?changed=1' })
}
