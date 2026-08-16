'use client'

import { useEffect, useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, CONTROL_CLASS, Field, Notice, Select } from '@/components/ui'
import { toMinor } from '@/domain/currency'
import { recordPaymentAction } from './actions'

const METHODS: Array<{ value: string; label: string }> = [
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'MOBILE_MONEY', label: 'Mobile money' },
  { value: 'CASH', label: 'Cash' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'OTHER', label: 'Other' }
]

/**
 * One selectable schedule entry, formatted on the server.
 *
 * `outstandingMinor` is a decimal *string*, not a bigint: a bigint cannot cross
 * the server/client boundary at all, and a number would be the one float in a
 * money path. It is parsed back with `BigInt()` here — lossless in both
 * directions — and `outstandingLabel` is the same figure already through
 * `formatMinor` on the server, so the client never formats money either.
 */
export interface PayableEntry {
  id: string
  /** "Installment 1 — due 2026-09-15 — $3,888.88 outstanding" */
  label: string
  /** "Installment 1", for the sentences beside the amount field. */
  title: string
  outstandingMinor: string
  outstandingLabel: string
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Minor units for what has been typed, or null when it is not yet a number.
 *
 * Null is "cannot tell", not "invalid": a half-typed "1." must not disable the
 * button underneath the person's fingers. The server validates the same string
 * with the same function, so the two can never disagree about what "1.5" means
 * in a currency with no decimal places.
 */
function typedMinor(amount: string, currency: string): bigint | null {
  const trimmed = amount.trim()
  if (!trimmed) return null
  try {
    return toMinor(trimmed, currency)
  } catch {
    return null
  }
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending || disabled} className="w-full sm:w-auto">
      {pending ? 'Recording…' : 'Record payment'}
    </Button>
  )
}

/**
 * Recording a payment, under the rule the platform now works by: the money
 * goes to the one schedule entry the agent picks, and never anywhere else.
 *
 * The select is required and has no default. That is the point of it — a
 * default is a decision the form makes on the agent's behalf, and the whole
 * reason this screen was rebuilt is that a payment landing somewhere nobody
 * chose is indistinguishable, to the person reading the schedule afterwards,
 * from a system inventing money.
 *
 * The client-side cap is convenience only. `recordPayment` refuses an
 * over-outstanding amount on its own, under the sale's row lock, against a
 * figure read inside the transaction — which is the only place the check can
 * actually be sound. This one just saves a round trip and says why the button
 * is dark.
 */
export function PaymentForm({
  saleId,
  currency,
  entries
}: {
  saleId: string
  currency: string
  entries: PayableEntry[]
}) {
  const [result, formAction] = useFormState(recordPaymentAction, undefined)
  const [entryId, setEntryId] = useState('')
  const [amount, setAmount] = useState('')
  const [formKey, setFormKey] = useState(0)

  // A recorded payment empties the form.
  //
  // The confirmation is what tells the agent it worked; this is what stops the
  // same figure sitting in the box afterwards, aimed at an entry that may still
  // be partly outstanding, one tap away from being recorded a second time. That
  // is the exact accident this screen was rebuilt around, so the form does not
  // keep the ammunition. Remounting via `key` clears the uncontrolled fields
  // too — reference, note, and the date back to today — while the notice above
  // survives it, because it lives outside the form.
  useEffect(() => {
    if (result?.ok) {
      setEntryId('')
      setAmount('')
      setFormKey((key) => key + 1)
    }
  }, [result])

  // Nothing left to pay: an empty select with a required attribute is a form
  // that can never be submitted and never says why.
  if (entries.length === 0) {
    return (
      <div className="space-y-3">
        <Notice result={result} />
        <p className="text-[15px] text-muted">
          Every entry on this schedule is fully paid — there is nothing left to record a payment
          against.
        </p>
      </div>
    )
  }

  const chosen = entries.find((entry) => entry.id === entryId) ?? null
  const parsed = typedMinor(amount, currency)
  const exceeds =
    chosen !== null && parsed !== null && parsed > BigInt(chosen.outstandingMinor)

  return (
    // The notice sits outside the form on purpose: the form is remounted on
    // success to clear itself, and the confirmation has to survive that.
    <div className="space-y-3">
      <Notice result={result} />

      <form key={formKey} action={formAction} className="space-y-3">
        <input type="hidden" name="saleId" value={saleId} />

        <Field label="Applies to" name="scheduleEntryId" required>
          <Select
            name="scheduleEntryId"
            required
            value={entryId}
            onChange={(event) => setEntryId(event.target.value)}
          >
            <option value="">Choose which payment this settles…</option>
            {entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Amount"
            name="amount"
            required
            hint={chosen ? `${chosen.title} has ${chosen.outstandingLabel} outstanding` : undefined}
          >
            <input
              name="amount"
              inputMode="decimal"
              placeholder="0.00"
              required
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className={CONTROL_CLASS}
            />
          </Field>
          <Field
            label="Date received"
            name="receivedAt"
            type="date"
            defaultValue={todayIso()}
            required
          />
        </div>

        {exceeds && chosen ? (
          // Amber, not red: nothing has failed yet. This is the form telling
          // the agent what it will refuse if they press the button, in the same
          // tone a partial payment is drawn in.
          <p className="rounded-btn border border-status-partial-border bg-status-partial-bg px-3 py-2 text-sm text-status-partial-text">
            That is more than {chosen.title} still owes. Enter {chosen.outstandingLabel} or less, or
            record the rest against another entry.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Method" name="method">
            <Select name="method" defaultValue="BANK_TRANSFER">
              {METHODS.map((method) => (
                <option key={method.value} value={method.value}>
                  {method.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reference" name="reference" placeholder="Optional" />
        </div>

        <Field label="Note" name="note" placeholder="Optional" />

        <SubmitButton disabled={chosen === null || exceeds} />
      </form>
    </div>
  )
}
