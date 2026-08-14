'use client'

import { useEffect, useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, CONTROL_CLASS, Card, ErrorText, Field, Select } from '@/components/ui'
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

/**
 * The design system's control shell. These inputs cannot use `Field`'s own
 * because each has to be `disabled` by state, which `Field` does not take — but
 * they must not therefore be a *different* input, which is what a local copy of
 * the class string had made them.
 */
const inputClass = CONTROL_CLASS

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
  currency,
  defaultFeeMode,
  defaultMarkupPercent,
  defaultFixedFee
}: {
  projectId: string
  unitId: string
  buyers: BuyerOption[]
  defaultTermMonths: number
  /** Named on the flat-fee field: the amount is typed in the project's money. */
  currency: string
  defaultFeeMode: 'PERCENT' | 'FIXED'
  defaultMarkupPercent: string
  /** Major units as a string — a bigint may not cross into a client component. */
  defaultFixedFee: string
}) {
  const action = previewSaleAction.bind(null, projectId, unitId)
  const [error, formAction] = useFormState(action, undefined)

  // A new buyer is the common case for a developer's agent: someone walks in,
  // they are registered and sold to in one sitting.
  const [buyerMode, setBuyerMode] = useState<'new' | 'existing'>('new')
  const [planType, setPlanType] = useState<'FULL' | 'INSTALLMENTS'>('INSTALLMENTS')
  // Seeded from the project, not hardcoded: a developer who charges a flat fee
  // opens this form on the flat-fee field, and the percentage input is the one
  // hidden and disabled. Both are server-rendered from this same initial value,
  // so the markup matches on both renders and a no-JS agent submits the
  // project's own mode with its own field enabled.
  const [feeMode, setFeeMode] = useState<'PERCENT' | 'FIXED'>(defaultFeeMode)

  // False through the server render and the first client render, so the markup
  // below is identical on both and hydration cannot mismatch. Only afterwards
  // does either buyer block get hidden.
  // Masked until the staff member asks for it — see the field below.
  const [passwordRevealed, setPasswordRevealed] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  const hasBuyers = buyers.length > 0
  const showNew = !hydrated || buyerMode === 'new'
  const showExisting = !hydrated || buyerMode === 'existing'

  return (
    <form action={formAction} className="space-y-5">
      <ErrorText>{error}</ErrorText>

      <Card>
        <h2 className="mb-3 text-base font-semibold text-navy-900">Buyer</h2>

        <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-btn border border-line bg-surface px-3">
            <input
              type="radio"
              name="buyerMode"
              value="new"
              checked={buyerMode === 'new'}
              onChange={() => setBuyerMode('new')}
            />
            <span className="text-[15px] text-ink">Register a new buyer</span>
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-btn border border-line bg-surface px-3">
            <input
              type="radio"
              name="buyerMode"
              value="existing"
              checked={buyerMode === 'existing'}
              onChange={() => setBuyerMode('existing')}
              disabled={!hasBuyers}
            />
            <span className="text-[15px] text-ink">
              Existing buyer{hasBuyers ? '' : ' (none registered yet)'}
            </span>
          </label>
        </div>

        <div className={showExisting ? 'space-y-4' : 'hidden'}>
          {hasBuyers ? (
            <Field label="Choose a buyer" name="buyerId">
              <Select name="buyerId" disabled={hydrated && buyerMode !== 'existing'}>
                {buyers.map((buyer) => (
                  <option key={buyer.id} value={buyer.id}>
                    {buyer.fullName} · {buyer.phone}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="text-[15px] text-muted">
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
            label={
              <span className="flex items-center justify-between gap-2">
                <span>Temporary password</span>
                <button
                  type="button"
                  onClick={() => setPasswordRevealed((value) => !value)}
                  aria-pressed={passwordRevealed}
                  className="text-[13px] font-medium text-teal-500"
                >
                  {passwordRevealed ? 'Hide' : 'Show'}
                </button>
              </span>
            }
            name="password"
            hint="Share this with the buyer — they can sign in with it immediately to follow their payments."
          >
            {/* Masked by default with a deliberate reveal: this value is set
                at a desk with the buyer sitting opposite, and it should not be
                the default state of the screen. Kept as a bare input rather
                than PasswordField because this one has to honour the
                new-versus-existing-buyer disable, which that component does
                not take. */}
            <input
              name="password"
              type={passwordRevealed ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              disabled={hydrated && buyerMode !== 'new'}
              className={inputClass}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-base font-semibold text-navy-900">Payment plan</h2>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-btn border border-line bg-surface px-3">
            <input
              type="radio"
              name="planType"
              value="INSTALLMENTS"
              checked={planType === 'INSTALLMENTS'}
              onChange={() => setPlanType('INSTALLMENTS')}
            />
            <span className="text-[15px] text-ink">Installments</span>
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-btn border border-line bg-surface px-3">
            <input
              type="radio"
              name="planType"
              value="FULL"
              checked={planType === 'FULL'}
              onChange={() => setPlanType('FULL')}
            />
            <span className="text-[15px] text-ink">Full payment</span>
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

        <div className={planType === 'INSTALLMENTS' ? 'mt-4 space-y-3' : 'hidden'}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-btn border border-line bg-surface px-3">
              <input
                type="radio"
                name="feeMode"
                value="PERCENT"
                checked={feeMode === 'PERCENT'}
                onChange={() => setFeeMode('PERCENT')}
                disabled={planType !== 'INSTALLMENTS'}
              />
              <span className="text-[15px] text-ink">Charge a percentage</span>
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-btn border border-line bg-surface px-3">
              <input
                type="radio"
                name="feeMode"
                value="FIXED"
                checked={feeMode === 'FIXED'}
                onChange={() => setFeeMode('FIXED')}
                disabled={planType !== 'INSTALLMENTS'}
              />
              <span className="text-[15px] text-ink">Charge a fixed amount</span>
            </label>
          </div>

          <div className={feeMode === 'PERCENT' ? '' : 'hidden'}>
            <Field
              label="Installment charge (%)"
              name="markupPercent"
              hint="Charged on the financed amount (price less deposit). Prefilled with this project's rate — leave it blank to use that rate."
            >
              <input
                name="markupPercent"
                defaultValue={defaultMarkupPercent}
                placeholder={defaultMarkupPercent}
                disabled={planType !== 'INSTALLMENTS' || feeMode !== 'PERCENT'}
                className={inputClass}
              />
            </Field>
          </div>

          {/* One flat fee, the same whatever the unit costs and whatever the
              deposit is — which is the point of it, and why this field is an
              amount rather than a rate. Interest is not permissible in some of
              the markets this platform serves. */}
          <div className={feeMode === 'FIXED' ? '' : 'hidden'}>
            <Field
              label={`Installment charge (${currency})`}
              name="fixedFee"
              hint="A flat amount, not a percentage — the same charge whatever the unit costs. It must be less than the amount being financed. Leave it blank to use this project's charge."
            >
              <input
                name="fixedFee"
                defaultValue={defaultFixedFee}
                placeholder={defaultFixedFee}
                disabled={planType !== 'INSTALLMENTS' || feeMode !== 'FIXED'}
                className={inputClass}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Submit />
    </form>
  )
}
