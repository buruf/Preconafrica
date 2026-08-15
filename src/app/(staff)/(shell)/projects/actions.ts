'use server'

import type { ZodError } from 'zod'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireAdmin, requireStaff } from '@/server/session'
import {
  CreateProjectSchema,
  UpdateProjectImagerySchema,
  createProject,
  unitTypeRowsFrom,
  updateProjectImagery
} from '@/server/services/projects'
import { UpdateUnitSchema, updateUnit } from '@/server/services/units'
import { imageFieldFrom } from '@/server/services/media'
import { ServiceError } from '@/server/services/errors'

/**
 * The first problem, said in a way that names the row it came from.
 *
 * The form shows one message, so on a form with eight unit positions on it
 * "Invalid size" is nearly useless on its own. Every unit-position issue —
 * zod's own and the currency-aware price check in the schema's superRefine
 * alike — carries `['unitTypes', index, …]`, so the prefix is added here in one
 * place rather than being baked into each message.
 */
function firstMessage(error: ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Please check the form and try again.'

  const [field, index] = issue.path
  if (field === 'unitTypes' && typeof index === 'number') {
    return `Unit position ${index + 1}: ${issue.message}`
  }
  return issue.message
}

export async function createProjectAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireStaff()
  const parsed = CreateProjectSchema.safeParse({
    ...Object.fromEntries(formData),
    // Last, so it wins over the flattened single value `Object.fromEntries`
    // leaves behind for each repeated row field.
    unitTypes: unitTypeRowsFrom(formData)
  })

  if (!parsed.success) {
    return firstMessage(parsed.error)
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

/**
 * The building photo, set from the card on the inventory page. ADMIN only at the
 * door as well as in the service — an agent should not even be handed the action.
 */
export async function updateProjectImageryAction(
  projectId: string,
  _prev: string | undefined,
  formData: FormData
) {
  const actor = await requireAdmin()

  const parsed = UpdateProjectImagerySchema.safeParse({
    // Read through `imageFieldFrom`, not `get(...) || undefined`: an emptied box
    // has to reach the service as '' (which parses to null and clears the
    // column), not as "unchanged".
    heroImageUrl: imageFieldFrom(formData, 'heroImageUrl') ?? ''
  })
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'That image URL is not valid.'

  try {
    await updateProjectImagery(actor, projectId, parsed.data)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not save the building photo.'
  }

  revalidatePath(`/projects/${projectId}`)
}

export async function updateUnitAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireStaff()
  const unitId = String(formData.get('unitId') ?? '')
  const projectId = String(formData.get('projectId') ?? '')

  const parsed = UpdateUnitSchema.safeParse({
    name: formData.get('name') || undefined,
    bedrooms: formData.get('bedrooms') || undefined,
    sizeSqm: formData.get('sizeSqm') || undefined,
    price: formData.get('price') || undefined,
    // Not the `|| undefined` idiom the four above use, and deliberately so: for
    // these two, empty is a value ("remove the image"), so the difference
    // between an absent field and an empty one has to survive the read.
    layoutImageUrl: imageFieldFrom(formData, 'layoutImageUrl'),
    renderImageUrls: imageFieldFrom(formData, 'renderImageUrls')
  })
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Invalid values.'

  try {
    await updateUnit(actor, unitId, parsed.data)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not update the unit.'
  }

  // Both screens that render this unit. The inventory grid shows its name and
  // status; the unit's own page — where this form now lives — shows everything
  // else, and without the second call the page you just submitted from would
  // redraw from cache with the values you replaced.
  revalidatePath(`/projects/${projectId}`)
  revalidatePath(`/projects/${projectId}/units/${unitId}`)
}
