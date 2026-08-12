'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/server/session'
import {
  CreateAgentSchema,
  UpdateOrganizationSchema,
  createAgent,
  deactivateAgent,
  updateOrganizationLogo
} from '@/server/services/team'
import { imageFieldFrom } from '@/server/services/media'
import { ServiceError } from '@/server/services/errors'

/**
 * The organisation's logo — the mark that heads every invoice. Lives here
 * because the team page is the only org-level admin surface in the app.
 */
export async function updateOrganizationLogoAction(
  _prev: string | undefined,
  formData: FormData
) {
  const actor = await requireAdmin()

  const parsed = UpdateOrganizationSchema.safeParse({
    logoUrl: imageFieldFrom(formData, 'logoUrl') ?? ''
  })
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'That image URL is not valid.'

  try {
    await updateOrganizationLogo(actor, parsed.data)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not save the logo.'
  }

  revalidatePath('/team')
}

export async function createAgentAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireAdmin()
  const parsed = CreateAgentSchema.safeParse(Object.fromEntries(formData))

  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Please check the form and try again.'
  }

  try {
    await createAgent(actor, parsed.data)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not add the agent.'
  }

  revalidatePath('/team')
}

export async function deactivateAgentAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')

  try {
    await deactivateAgent(actor, userId)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not deactivate the agent.'
  }

  revalidatePath('/team')
}
