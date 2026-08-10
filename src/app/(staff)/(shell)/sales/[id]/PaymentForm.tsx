'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Field } from '@/components/ui'
import { recordPaymentAction } from './actions'

const METHODS: Array<{ value: string; label: string }> = [
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'MOBILE_MONEY', label: 'Mobile money' },
  { value: 'CASH', label: 'Cash' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'OTHER', label: 'Other' }
]

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full sm:w-auto">
      {pending ? 'Recording…' : 'Record payment'}
    </Button>
  )
}

/**
 * The returned message from recordPaymentAction is either a validation/
 * conflict error or the overpayment notice — both must be visible, but they
 * are not the same kind of news, so they get distinct styling rather than
 * both going through the rose-tinted ErrorText box. "Recorded." is the
 * literal prefix the action uses for the overpayment case (see actions.ts).
 */
export function PaymentForm({ saleId }: { saleId: string }) {
  const [message, formAction] = useFormState(recordPaymentAction, undefined)
  const isOverpaymentNotice = message?.startsWith('Recorded.') ?? false

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="saleId" value={saleId} />

      {message ? (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-sm ${
            isOverpaymentNotice ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-700'
          }`}
        >
          {message}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Amount" name="amount" placeholder="0.00" required />
        <Field label="Date received" name="receivedAt" type="date" defaultValue={todayIso()} required />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Method" name="method">
          <select
            name="method"
            defaultValue="BANK_TRANSFER"
            className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base outline-none focus:border-slate-900"
          >
            {METHODS.map((method) => (
              <option key={method.value} value={method.value}>
                {method.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reference" name="reference" placeholder="Optional" />
      </div>

      <Field label="Note" name="note" placeholder="Optional" />

      <SubmitButton />
    </form>
  )
}
