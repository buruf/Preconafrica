'use server'

import { revalidatePath } from 'next/cache'
import { requireStaff, requireAdmin } from '@/server/session'
import { RecordPaymentSchema, recordPayment, voidPayment } from '@/server/services/payments'
import { issueInvoice } from '@/server/documents/issue'
import { ServiceError } from '@/server/services/errors'
import { formatMinor } from '@/domain/currency'
import { prisma } from '@/server/db'

export async function recordPaymentAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireStaff()
  const parsed = RecordPaymentSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Please check the payment details.'

  try {
    const { overpaymentMinor } = await recordPayment(actor, parsed.data)
    revalidatePath(`/sales/${parsed.data.saleId}`)
    revalidatePath('/arrears')

    if (overpaymentMinor > 0n) {
      // Currency is re-queried, never trusted from the client — the form has
      // no currency field, and even if it did, a tampered value here would
      // misreport the surplus in the wrong denomination.
      const sale = await prisma.sale.findUniqueOrThrow({
        where: { id: parsed.data.saleId },
        select: { currency: true }
      })
      // Surfaced, never silently absorbed.
      return `Recorded. ${formatMinor(overpaymentMinor, sale.currency)} exceeded the outstanding balance and was not allocated.`
    }
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not record the payment.'
  }
}

export async function voidPaymentAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireAdmin()
  const saleId = String(formData.get('saleId') ?? '')
  try {
    await voidPayment(actor, String(formData.get('paymentId') ?? ''), String(formData.get('reason') ?? ''))
    revalidatePath(`/sales/${saleId}`)
    revalidatePath('/arrears')
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not void the payment.'
  }
}

export async function issueInvoiceAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireStaff()
  const saleId = String(formData.get('saleId') ?? '')
  try {
    await issueInvoice(actor, String(formData.get('scheduleEntryId') ?? ''))
    revalidatePath(`/sales/${saleId}`)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not issue the invoice.'
  }
}
