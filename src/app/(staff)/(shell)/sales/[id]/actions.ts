'use server'

import { revalidatePath } from 'next/cache'
import { requireStaff, requireAdmin } from '@/server/session'
import { RecordPaymentSchema, recordPayment, voidPayment } from '@/server/services/payments'
import { issueInvoice } from '@/server/documents/issue'
import { ServiceError } from '@/server/services/errors'
import { formatMinor } from '@/domain/currency'
import { scheduleEntryListPhrase, scheduleEntryPhrase } from '@/domain/schedule'
import type { ActionResult } from '@/components/ui'
import { prisma } from '@/server/db'

/** "the deposit" -> "The deposit", for a phrase that has to open a sentence. */
function openSentence(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/**
 * Every action on this page answers with a result, success included.
 *
 * They used to return a string on failure and nothing at all on success, which
 * left the agent staring at a form that looked exactly as it had before they
 * pressed the button. The owner recorded a $50,000 deposit twice because of it.
 * A confirmation naming the figure, where it landed and the receipt it produced
 * is the fix, and it costs one field.
 */
export async function recordPaymentAction(
  _prev: ActionResult | undefined,
  formData: FormData
): Promise<ActionResult> {
  const actor = await requireStaff()
  const parsed = RecordPaymentSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Please check the payment details.'
    }
  }

  try {
    // Every figure in the sentence below comes back from the service, which
    // read them inside the payment's own transaction: the amount as it was
    // actually applied, the entry it was applied to, and the receipt that was
    // minted for it. None of them is taken from the form, and the currency is
    // the sale's own rather than anything the client could name.
    const { amountMinor, currency, entrySequence, receiptNumber } = await recordPayment(
      actor,
      parsed.data
    )
    revalidatePath(`/sales/${parsed.data.saleId}`)
    revalidatePath('/arrears')

    return {
      ok: true,
      message: `Recorded ${formatMinor(amountMinor, currency)} against ${scheduleEntryPhrase(entrySequence)}. Receipt ${receiptNumber}.`
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ServiceError ? error.message : 'Could not record the payment.'
    }
  }
}

export async function voidPaymentAction(
  _prev: ActionResult | undefined,
  formData: FormData
): Promise<ActionResult> {
  const actor = await requireAdmin()
  const saleId = String(formData.get('saleId') ?? '')
  try {
    const { amountMinor, currency, entrySequences } = await voidPayment(
      actor,
      String(formData.get('paymentId') ?? ''),
      String(formData.get('reason') ?? '')
    )
    revalidatePath(`/sales/${saleId}`)
    revalidatePath('/arrears')

    // Under the targeted rule that list is always one entry. A payment
    // recorded under the old cascade can name several, and this says so
    // instead of pretending otherwise — the history is valid and the person
    // voiding it deserves to know how much of the schedule just moved.
    const restored = entrySequences.length
      ? ` ${openSentence(scheduleEntryListPhrase(entrySequences))} ${entrySequences.length === 1 ? 'is' : 'are'} outstanding again.`
      : ''

    return { ok: true, message: `Voided ${formatMinor(amountMinor, currency)}.${restored}` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ServiceError ? error.message : 'Could not void the payment.'
    }
  }
}

export async function issueInvoiceAction(
  _prev: ActionResult | undefined,
  formData: FormData
): Promise<ActionResult> {
  const actor = await requireStaff()
  const saleId = String(formData.get('saleId') ?? '')
  try {
    const { documentId } = await issueInvoice(actor, String(formData.get('scheduleEntryId') ?? ''))
    revalidatePath(`/sales/${saleId}`)

    // Read back rather than returned from issueInvoice: that function is
    // idempotent and shared with the buyer's dashboard, and its contract — in
    // particular the order in which it decides NOT_FOUND — is deliberately
    // left alone. One indexed lookup by primary key is the cheaper change.
    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { number: true, scheduleEntry: { select: { sequence: true } } }
    })
    const target = document.scheduleEntry
      ? ` for ${scheduleEntryPhrase(document.scheduleEntry.sequence)}`
      : ''

    return { ok: true, message: `Invoice ${document.number} issued${target}.` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ServiceError ? error.message : 'Could not issue the invoice.'
    }
  }
}
