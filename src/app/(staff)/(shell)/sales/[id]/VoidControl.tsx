'use client'

import { useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, ErrorText } from '@/components/ui'
import { voidPaymentAction } from './actions'

function ConfirmButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="danger" disabled={pending} className="w-full sm:w-auto">
      {pending ? 'Voiding…' : 'Confirm void'}
    </Button>
  )
}

/**
 * ADMIN-only, and only ever rendered by the parent page for non-voided
 * payments (see page.tsx) — this component itself does not re-check the
 * role, because the real gate is voidPaymentAction's requireAdmin(), not the
 * visibility of this button. Collapsed by default so a reason is always
 * typed deliberately, never submitted by an accidental tap.
 */
export function VoidControl({ saleId, paymentId }: { saleId: string; paymentId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [error, formAction] = useFormState(voidPaymentAction, undefined)

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="inline-flex min-h-11 items-center text-sm font-medium text-rose-700 underline"
      >
        Void
      </button>
    )
  }

  return (
    <form action={formAction} className="w-full space-y-2 sm:w-64">
      <input type="hidden" name="saleId" value={saleId} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <ErrorText>{error}</ErrorText>
      <input
        name="reason"
        placeholder="Reason for voiding"
        required
        className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base outline-none focus:border-slate-900"
      />
      <div className="flex gap-2">
        <ConfirmButton />
        <Button type="button" variant="secondary" onClick={() => setExpanded(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
