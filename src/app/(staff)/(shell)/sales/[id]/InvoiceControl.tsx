'use client'

import Link from 'next/link'
import { useFormState, useFormStatus } from 'react-dom'
import { Notice } from '@/components/ui'
import { issueInvoiceAction } from './actions'

function IssueButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-11 items-center text-sm font-semibold text-navy-900 underline disabled:opacity-50"
    >
      {pending ? 'Issuing…' : 'Issue invoice'}
    </button>
  )
}

/**
 * `documentId` comes from the server-rendered page, not from local state — a
 * successful issueInvoiceAction calls revalidatePath on the sale, the parent
 * re-fetches getSaleForStaff, and this component re-renders with the new id,
 * which is what swaps the button for the download link (issueInvoice itself
 * is idempotent, so a second render with the same id is harmless).
 *
 * Offered on every installment, whatever has been paid: an invoice is a demand
 * for payment, so the row an agent most needs to bill is precisely the one with
 * nothing against it yet.
 */
export function InvoiceControl({
  saleId,
  scheduleEntryId,
  documentId
}: {
  saleId: string
  scheduleEntryId: string
  documentId: string | null
}) {
  const [result, formAction] = useFormState(issueInvoiceAction, undefined)

  if (documentId) {
    return (
      // The confirmation rides along with the download link that replaced the
      // button: issuing succeeds, the page revalidates, and without this the
      // only sign anything happened would be a word quietly changing.
      <div className="space-y-2">
        <Notice result={result} />
        <Link
          href={`/api/documents/${documentId}`}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-navy-900 underline"
        >
          Invoice
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Notice result={result} />
      <form action={formAction}>
        <input type="hidden" name="saleId" value={saleId} />
        <input type="hidden" name="scheduleEntryId" value={scheduleEntryId} />
        <IssueButton />
      </form>
    </div>
  )
}
