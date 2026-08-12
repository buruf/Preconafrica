'use server'

import { redirect } from 'next/navigation'
import { PasswordSchema, confirmationMatches } from '@/domain/password-reset'
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

  try {
    await resetPassword(token, password, new Date())
  } catch (error) {
    // The service already collapses every token failure into one message, so
    // there is nothing to differentiate here.
    return error instanceof ServiceError ? error.message : 'Could not reset your password.'
  }

  redirect('/login?reset=1')
}
