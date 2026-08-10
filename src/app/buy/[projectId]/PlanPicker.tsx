'use client'

import { useState } from 'react'
import { Field } from '@/components/ui'

/**
 * Radios for FULL vs INSTALLMENTS.
 *
 * Degrades without JavaScript by construction: INSTALLMENTS is the default
 * (this is an installment-sales product) and the deposit/term fields are in
 * the server-rendered DOM from the start. JavaScript only ever *hides* them —
 * choosing FULL removes and disables them — so a no-JS buyer always sees and
 * can fill every field their native radio choice needs. Disabled fields do
 * not submit, so a JS-enabled FULL submission carries no deposit/term and
 * lands on PlanSelectionSchema's defaults; the schema also forces deposit to
 * '0' for FULL regardless, so a no-JS FULL submission with a stray deposit
 * typed in is normalised server-side rather than trusted.
 *
 * Deposit is deliberately not `required`: blank means no deposit (schema
 * default '0'), which is a legitimate installment plan.
 */
export function PlanPicker({ defaultTermMonths }: { defaultTermMonths: number }) {
  const [planType, setPlanType] = useState<'FULL' | 'INSTALLMENTS'>('INSTALLMENTS')

  return (
    <div className="space-y-4">
      <span className="block text-sm font-medium text-slate-700">Payment plan</span>

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
        className={planType === 'INSTALLMENTS' ? 'grid grid-cols-1 gap-3 sm:grid-cols-2' : 'hidden'}
      >
        <Field
          label="Deposit (optional)"
          name="deposit"
          placeholder="5000000"
          hint="In the project's currency. Leave blank for no deposit."
        >
          <input
            name="deposit"
            placeholder="5000000"
            disabled={planType !== 'INSTALLMENTS'}
            className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base outline-none focus:border-slate-900"
          />
        </Field>
        <Field label="Term (months)" name="termMonths" type="number">
          <input
            name="termMonths"
            type="number"
            defaultValue={defaultTermMonths}
            disabled={planType !== 'INSTALLMENTS'}
            className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base outline-none focus:border-slate-900"
          />
        </Field>
      </div>
    </div>
  )
}
