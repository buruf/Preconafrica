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
 */
export function InvoiceControl({
  scheduleEntryId,
  documentId,
  /** Server-decided, and a boolean rather than a `bigint` — see the staff twin. */
  hasPayment
}: {
  scheduleEntryId: string
  documentId: string | null
  hasPayment: boolean
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

  // The absence is explained rather than mysterious: a buyer who has not paid
  // anything toward this month sees why there is nothing to download, not a
  // button that fails.
  if (!hasPayment) {
    return (
      <p className="inline-flex min-h-11 items-center text-xs text-slate-500">
        Invoice available once a payment is recorded
      </p>
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
