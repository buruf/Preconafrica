'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, ErrorText } from '@/components/ui'
import { createStaffSaleAction } from '../actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Signing…' : 'Confirm and sign'}
    </Button>
  )
}

/**
 * Everything the agent and buyer just read in the preview above, carried
 * forward unchanged as hidden fields. This form cannot alter the plan at the
 * point of commitment — only confirm it or go back — so the schedule that gets
 * written is the schedule that was quoted.
 *
 * `markupBps` is carried as a string or omitted entirely: an absent field means
 * "the project default", which is what the confirm page priced. Sending 0 in
 * its place would sign a fee-free contract that nobody agreed to.
 */
export function ConfirmForm({
  unitId,
  buyerId,
  planType,
  deposit,
  termMonths,
  markupBps
}: {
  unitId: string
  buyerId: string
  planType: string
  deposit: string
  termMonths: number
  markupBps: number | null
}) {
  // Bound to the route's unit so a tampered hidden field cannot sign this
  // page's quoted terms against a different unit — the action cross-checks.
  const [error, formAction] = useFormState(createStaffSaleAction.bind(null, unitId), undefined)

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="unitId" value={unitId} />
      <input type="hidden" name="buyerId" value={buyerId} />
      <input type="hidden" name="planType" value={planType} />
      <input type="hidden" name="deposit" value={deposit} />
      <input type="hidden" name="termMonths" value={termMonths} />
      {markupBps === null ? null : (
        <input type="hidden" name="markupBps" value={markupBps} />
      )}
      <ErrorText>{error}</ErrorText>
      <Submit />
    </form>
  )
}
