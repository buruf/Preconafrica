'use client'

import Link from 'next/link'
import { useFormState, useFormStatus } from 'react-dom'
import { ErrorText } from '@/components/ui'
import { issueInvoiceAction } from './actions'

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
 * `documentId` comes from the server-rendered page, not from local state — a
 * successful issueInvoiceAction calls revalidatePath on the sale, the parent
 * re-fetches getSaleForStaff, and this component re-renders with the new id,
 * which is what swaps the button for the download link (issueInvoice itself
 * is idempotent, so a second render with the same id is harmless).
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
  const [error, formAction] = useFormState(issueInvoiceAction, undefined)

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
        <input type="hidden" name="saleId" value={saleId} />
        <input type="hidden" name="scheduleEntryId" value={scheduleEntryId} />
        <IssueButton />
      </form>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
