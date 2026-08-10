'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireStaff } from '@/server/session'
import { CreateProjectSchema, createProject } from '@/server/services/projects'
import { UpdateUnitSchema, updateUnit } from '@/server/services/units'
import { ServiceError } from '@/server/services/errors'

export async function createProjectAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireStaff()
  const parsed = CreateProjectSchema.safeParse(Object.fromEntries(formData))

  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Please check the form and try again.'
  }

  let projectId: string
  try {
    const result = await createProject(actor, parsed.data)
    projectId = result.id
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not create the project.'
  }

  redirect(`/projects/${projectId}`)
}

export async function updateUnitAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireStaff()
  const unitId = String(formData.get('unitId') ?? '')
  const projectId = String(formData.get('projectId') ?? '')

  const parsed = UpdateUnitSchema.safeParse({
    name: formData.get('name') || undefined,
    bedrooms: formData.get('bedrooms') || undefined,
    sizeSqm: formData.get('sizeSqm') || undefined,
    price: formData.get('price') || undefined
  })
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Invalid values.'

  try {
    await updateUnit(actor, unitId, parsed.data)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not update the unit.'
  }

  revalidatePath(`/projects/${projectId}`)
}
