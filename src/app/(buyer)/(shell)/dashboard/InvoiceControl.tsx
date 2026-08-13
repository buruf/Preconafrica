'use client'

import Link from 'next/link'
import { useFormState, useFormStatus } from 'react-dom'
import { ErrorText } from '@/components/ui'
import { issueOwnInvoiceAction } from './actions'

function IssueButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-11 items-center text-sm font-medium underline disabled:opacity-50"
    >
      {pending ? 'Issuing…' : 'Issue invoice'}
    </button>
  )
}

/**
 * The buyer-side twin of the staff InvoiceControl, and for the same reason:
 * `documentId` comes from the server-rendered page rather than local state, so
 * a successful action's revalidatePath('/dashboard') is what swaps the button
 * for the download link. There is no saleId field — the buyer's sale is
 * resolved from their session, never from the form.
 *
 * Offered on every installment — see the staff twin. A buyer whose employer
 * wants a bill before they transfer the money is the ordinary reason to tap it.
 */
export function InvoiceControl({
  scheduleEntryId,
  documentId
}: {
  scheduleEntryId: string
  documentId: string | null
}) {
  const [error, formAction] = useFormState(issueOwnInvoiceAction, undefined)

  if (documentId) {
    return (
      <Link
        href={`/api/documents/${documentId}`}
        className="inline-flex min-h-11 items-center text-sm font-medium underline"
      >
        Invoice
      </Link>
    )
  }

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="scheduleEntryId" value={scheduleEntryId} />
        <IssueButton />
      </form>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
