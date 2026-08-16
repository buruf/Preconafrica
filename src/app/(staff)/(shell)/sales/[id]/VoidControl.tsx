'use client'

import { useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, CONTROL_CLASS, Notice } from '@/components/ui'
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
 * ADMIN-only — this component does not re-check the role, because the real
 * gate is voidPaymentAction's requireAdmin(), not the visibility of a button.
 * Collapsed by default so a reason is always typed deliberately, never
 * submitted by an accidental tap.
 *
 * `voided` rather than the parent simply not rendering this at all once the
 * payment is struck: a successful void revalidates the page, and if the
 * control vanished on that render it would take its own confirmation with it,
 * leaving the admin with the same silence that made a deposit get recorded
 * twice. Voided, it is nothing but the sentence saying so.
 */
export function VoidControl({
  saleId,
  paymentId,
  voided
}: {
  saleId: string
  paymentId: string
  voided: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [result, formAction] = useFormState(voidPaymentAction, undefined)

  if (voided) return <Notice result={result} />

  if (!expanded) {
    return (
      <div className="space-y-2">
        <Notice result={result} />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-status-overdue-text underline"
        >
          Void
        </button>
      </div>
    )
  }

  return (
    <form action={formAction} className="w-full space-y-2 sm:w-64">
      <input type="hidden" name="saleId" value={saleId} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <Notice result={result} />
      <input
        name="reason"
        placeholder="Reason for voiding"
        required
        className={CONTROL_CLASS}
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
