'use client'

import { useEffect, useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { previewSaleAction } from './actions'

export interface BuyerOption {
  id: string
  fullName: string
  phone: string
}

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Working…' : 'Preview the payment schedule'}
    </Button>
  )
}

const inputClass =
  'min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base outline-none focus:border-slate-900'

/**
 * The whole of step 1 of a staff sale in one form: who is buying, on what
 * plan, at what charge. One submit hands it to `previewSaleAction`, which
 * registers the buyer if they are new and redirects to the confirm step with
 * nothing about the sale yet committed.
 *
 * Two things here degrade without JavaScript, both by the same rule — the
 * server renders every field enabled and JavaScript only ever hides:
 *
 *  - The buyer blocks. Both are in the server HTML, both enabled, until
 *    hydration; the `hydrated` flag is what keeps a no-JS agent from meeting a
 *    `disabled` block they cannot fill. Whichever `buyerMode` radio is checked
 *    decides which half the action reads, so the other half submitting stray
 *    values costs nothing.
 *  - The plan fields. INSTALLMENTS is the default (this is an installment-sales
 *    product) and deposit/term are server-rendered from the start; choosing
 *    FULL hides and disables them, and `PlanSelectionSchema` forces the deposit
 *    to zero for a FULL plan regardless of what arrives.
 */
export function SellForm({
  projectId,
  unitId,
  buyers,
  defaultTermMonths,
  defaultMarkupPercent
}: {
  projectId: string
  unitId: string
  buyers: BuyerOption[]
  defaultTermMonths: number
  defaultMarkupPercent: string
}) {
  const action = previewSaleAction.bind(null, projectId, unitId)
  const [error, formAction] = useFormState(action, undefined)

  // A new buyer is the common case for a developer's agent: someone walks in,
  // they are registered and sold to in one sitting.
  const [buyerMode, setBuyerMode] = useState<'new' | 'existing'>('new')
  const [planType, setPlanType] = useState<'FULL' | 'INSTALLMENTS'>('INSTALLMENTS')

  // False through the server render and the first client render, so the markup
  // below is identical on both and hydration cannot mismatch. Only afterwards
  // does either buyer block get hidden.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  const hasBuyers = buyers.length > 0
  const showNew = !hydrated || buyerMode === 'new'
  const showExisting = !hydrated || buyerMode === 'existing'

  return (
    <form action={formAction} className="space-y-5">
      <ErrorText>{error}</ErrorText>

      <Card>
        <h2 className="mb-3 font-semibold">Buyer</h2>

        <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3">
            <input
              type="radio"
              name="buyerMode"
              value="new"
              checked={buyerMode === 'new'}
              onChange={() => setBuyerMode('new')}
            />
            <span className="text-sm">Register a new buyer</span>
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3">
            <input
              type="radio"
              name="buyerMode"
              value="existing"
              checked={buyerMode === 'existing'}
              onChange={() => setBuyerMode('existing')}
              disabled={!hasBuyers}
            />
            <span className="text-sm">
              Existing buyer{hasBuyers ? '' : ' (none registered yet)'}
            </span>
          </label>
        </div>

        <div className={showExisting ? 'space-y-4' : 'hidden'}>
          {hasBuyers ? (
            <Field label="Choose a buyer" name="buyerId">
              <select
                name="buyerId"
                disabled={hydrated && buyerMode !== 'existing'}
                className={inputClass}
              >
                {buyers.map((buyer) => (
                  <option key={buyer.id} value={buyer.id}>
                    {buyer.fullName} · {buyer.phone}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="text-sm text-slate-500">
              No buyers are registered for your organisation yet. Register this one below.
            </p>
          )}
        </div>

        <div className={showNew ? 'space-y-4' : 'hidden'}>
          <Field label="Full name" name="fullName">
            <input
              name="fullName"
              placeholder="Amina Yusuf"
              disabled={hydrated && buyerMode !== 'new'}
              className={inputClass}
            />
          </Field>
          <Field label="Phone" name="phone" hint="Include the country code, e.g. +2348031234567">
            <input
              name="phone"
              placeholder="+2348031234567"
              disabled={hydrated && buyerMode !== 'new'}
              className={inputClass}
            />
          </Field>
          <Field label="Email" name="email">
            <input
              name="email"
              type="email"
              placeholder="amina@example.com"
              disabled={hydrated && buyerMode !== 'new'}
              className={inputClass}
            />
          </Field>
          <Field label="Address" name="address">
            <input
              name="address"
              placeholder="Optional"
              disabled={hydrated && buyerMode !== 'new'}
              className={inputClass}
            />
          </Field>
          <Field
            label="Temporary password"
            name="password"
            hint="Share this with the buyer — they can sign in with it immediately to follow their payments."
          >
            <input
              name="password"
              type="text"
              placeholder="At least 8 characters"
              disabled={hydrated && buyerMode !== 'new'}
              className={inputClass}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">Payment plan</h2>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3">
            <input
              type="radio"
              name="planType"
              value="INSTALLMENTS"
              checked={planType === 'INSTALLMENTS'}
              onChange={() => setPlanType('INSTALLMENTS')}
            />
            <span className="text-sm">Installments</span>
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3">
            <input
              type="radio"
              name="planType"
              value="FULL"
              checked={planType === 'FULL'}
              onChange={() => setPlanType('FULL')}
            />
            <span className="text-sm">Full payment</span>
          </label>
        </div>

        <div
          className={
            planType === 'INSTALLMENTS' ? 'mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2' : 'hidden'
          }
        >
          <Field
            label="Deposit (optional)"
            name="deposit"
            hint="Due at signing. Leave blank for no deposit."
          >
            <input
              name="deposit"
              placeholder="5000000"
              disabled={planType !== 'INSTALLMENTS'}
              className={inputClass}
            />
          </Field>
          <Field label="Term (months)" name="termMonths">
            <input
              name="termMonths"
              type="number"
              defaultValue={defaultTermMonths}
              disabled={planType !== 'INSTALLMENTS'}
              className={inputClass}
            />
          </Field>
        </div>

        <div className={planType === 'INSTALLMENTS' ? 'mt-4' : 'hidden'}>
          <Field
            label="Installment charge (%)"
            name="markupPercent"
            hint="Charged on the financed amount (price less deposit). Prefilled with this project's rate — leave it blank to use that rate."
          >
            <input
              name="markupPercent"
              defaultValue={defaultMarkupPercent}
              placeholder={defaultMarkupPercent}
              disabled={planType !== 'INSTALLMENTS'}
              className={inputClass}
            />
          </Field>
        </div>
      </Card>

      <Submit />
    </form>
  )
}
