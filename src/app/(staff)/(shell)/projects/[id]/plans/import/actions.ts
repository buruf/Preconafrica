'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { assignLayoutToUnits } from '@/server/services/units'

/**
 * The only write the importer performs.
 *
 * Thin on purpose: it guards, delegates, and turns a ServiceError into a
 * sentence. The audit entry is the service's to record — a server action that
 * imported the recorder would fail `audit-call-sites.test.ts`, and rightly so:
 * an entry written here would describe what this action believed rather than
 * what the service wrote.
 *
 * Not a `useFormState` action: the importer calls it once per chosen page with
 * a list the client assembled, which is not a form submission.
 */
export async function assignPlanAction(
  projectId: string,
  imageUrl: string,
  unitIds: string[]
): Promise<string | undefined> {
  const actor = await requireAdmin()

  try {
    await assignLayoutToUnits(actor, { projectId, imageUrl, unitIds })
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Those plans could not be saved.'
  }

  // The inventory tiles show the drawing, so the project page is stale now.
  revalidatePath(`/projects/${projectId}`)
  return undefined
}
