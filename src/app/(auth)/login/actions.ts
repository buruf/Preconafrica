'use server'

import { AuthError } from 'next-auth'
import { signIn } from '@/server/auth'

export async function loginAction(_prev: string | undefined, formData: FormData) {
  try {
    await signIn('credentials', {
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      redirectTo: '/'
    })
  } catch (error) {
    if (error instanceof AuthError) {
      // One message for both wrong-email and wrong-password, so the form
      // cannot be used to discover which addresses are registered.
      return 'Email or password is incorrect.'
    }
    throw error
  }
}
