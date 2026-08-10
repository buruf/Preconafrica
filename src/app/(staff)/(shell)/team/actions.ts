'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/server/session'
import { CreateAgentSchema, createAgent, deactivateAgent } from '@/server/services/team'
import { ServiceError } from '@/server/services/errors'

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
