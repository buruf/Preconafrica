'use server'

import { revalidatePath } from 'next/cache'
import { signOut } from '@/server/auth'
import { requirePlatformAdmin } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { createDeveloper, setDeveloperSuspended } from '@/server/services/platform'

/**
 * Every action here starts with `requirePlatformAdmin`, which refuses a
 * developer's token however privileged they are inside their own organisation.
 * The guard is per-action rather than per-layout because a layout cannot
 * protect a server action — the action is its own entry point.
 */

export async function createDeveloperAction(_prev: unknown, formData: FormData) {
  const actor = await requirePlatformAdmin()

  try {
    const result = await createDeveloper(actor, {
      name: String(formData.get('name') ?? ''),
      slug: String(formData.get('slug') ?? ''),
      adminFullName: String(formData.get('adminFullName') ?? ''),
      adminEmail: String(formData.get('adminEmail') ?? '')
    })

    revalidatePath('/platform')
    // The temporary password is returned to the screen that asked for it and
    // is never persisted in readable form. It is shown once; after that the
    // only way back is for the developer to reset it.
    return {
      ok: true as const,
      temporaryPassword: result.temporaryPassword,
      adminEmail: String(formData.get('adminEmail') ?? '').trim().toLowerCase()
    }
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof ServiceError ? error.message : 'That developer could not be created.'
    }
  }
}

export async function setSuspendedAction(orgId: string, suspended: boolean) {
  const actor = await requirePlatformAdmin()

  try {
    await setDeveloperSuspended(actor, orgId, suspended)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'That change could not be saved.'
  }

  revalidatePath('/platform')
  revalidatePath(`/platform/developers/${orgId}`)
  return undefined
}

export async function platformSignOutAction() {
  await signOut({ redirectTo: '/platform/login' })
}
