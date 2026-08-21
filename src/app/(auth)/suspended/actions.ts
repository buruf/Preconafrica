'use server'

import { signOut } from '@/server/auth'

/**
 * The only action available to a suspended organisation's staff.
 *
 * No guard beyond what `signOut` implies: ending your own session is safe for
 * anyone to do, and refusing it would strand someone on a screen with no way
 * off it.
 */
export async function signOutAction() {
  await signOut({ redirectTo: '/login' })
}
