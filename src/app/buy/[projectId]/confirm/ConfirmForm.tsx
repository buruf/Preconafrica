'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, ErrorText } from '@/components/ui'
import { createSaleAction } from '../actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Confirming…' : 'Confirm and sign'}
    </Button>
  )
}

/**
 * Everything the buyer already saw in the schedule preview above this form is
 * carried forward as hidden fields, unchanged — this form does not let the
 * buyer alter the plan at the point of commitment, only confirm or go back.
 */
export function ConfirmForm({
  unitId,
  planType,
  deposit,
  termMonths
}: {
  unitId: string
  planType: string
  deposit: string
  termMonths: number
}) {
  const [error, formAction] = useFormState(createSaleAction, undefined)

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="unitId" value={unitId} />
      <input type="hidden" name="planType" value={planType} />
      <input type="hidden" name="deposit" value={deposit} />
      <input type="hidden" name="termMonths" value={termMonths} />
      <ErrorText>{error}</ErrorText>
      <Submit />
    </form>
  )
}
