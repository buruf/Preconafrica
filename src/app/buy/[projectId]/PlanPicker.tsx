'use client'

import { useState } from 'react'
import { Field } from '@/components/ui'

/**
 * The only client component on this page besides the form itself. Radios for
 * FULL vs INSTALLMENTS; the deposit and term inputs only exist in the DOM
 * (and therefore only submit) when INSTALLMENTS is selected, so a FULL
 * submission always lands on PlanSelectionSchema's deposit default of '0'.
 */
export function PlanPicker({ defaultTermMonths }: { defaultTermMonths: number }) {
  const [planType, setPlanType] = useState<'FULL' | 'INSTALLMENTS'>('FULL')

  return (
    <div className="space-y-4">
      <span className="block text-sm font-medium text-slate-700">Payment plan</span>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
      </div>

      {planType === 'INSTALLMENTS' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Deposit"
            name="deposit"
            required
            placeholder="5000000"
            hint="In the project's currency, before the monthly installments start."
          />
          <Field
            label="Term (months)"
            name="termMonths"
            type="number"
            required
            defaultValue={defaultTermMonths}
          />
        </div>
      ) : null}
    </div>
  )
}
