'use server'

import { revalidatePath } from 'next/cache'
import { requireBuyer } from '@/server/session'
import { issueInvoice } from '@/server/documents/issue'
import { ServiceError } from '@/server/services/errors'

/**
 * A buyer issuing their own invoice. Deliberately separate from the staff
 * action of the same name: this one's guard is `requireBuyer`, and the
 * scheduleEntryId it forwards is scoped to the caller's own sale inside
 * `issueInvoice` (see the buyer narrowing there) — so the id arriving from a
 * form field cannot reach another buyer's installment.
 */
export async function issueOwnInvoiceAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireBuyer()
  try {
    await issueInvoice(actor, String(formData.get('scheduleEntryId') ?? ''))
    revalidatePath('/dashboard')
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not issue the invoice.'
  }
}
