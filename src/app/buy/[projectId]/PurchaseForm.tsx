'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { PlanPicker } from './PlanPicker'
import { registerAndSelectAction } from './actions'

export interface AvailableUnitOption {
  id: string
  name: string
  floor: number
  bedrooms: number
  sizeSqm: string
  priceLabel: string
}

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending || disabled} className="w-full">
      {pending ? 'Submitting…' : 'See my payment schedule'}
    </Button>
  )
}

/**
 * The whole of step 1 in one form: registration (skipped when the visitor is
 * already signed in as a buyer), unit choice, and plan choice. One submit
 * hands everything to registerAndSelectAction, which validates both halves
 * and redirects to the confirm page with nothing yet committed.
 */
export function PurchaseForm({
  projectId,
  signedInAsName,
  units,
  defaultTermMonths
}: {
  projectId: string
  signedInAsName: string | null
  units: AvailableUnitOption[]
  defaultTermMonths: number
}) {
  const action = registerAndSelectAction.bind(null, projectId)
  const [error, formAction] = useFormState(action, undefined)

  return (
    <form action={formAction} className="space-y-5">
      <ErrorText>{error}</ErrorText>

      {signedInAsName ? (
        <Card>
          <p className="text-sm text-slate-700">
            You&apos;re signed in as <strong>{signedInAsName}</strong>.
          </p>
        </Card>
      ) : (
        <Card>
          <h2 className="mb-3 font-semibold">Your details</h2>
          <div className="space-y-4">
            <Field label="Full name" name="fullName" required />
            <Field
              label="Phone"
              name="phone"
              required
              placeholder="+2348031234567"
              hint="Include your country code, e.g. +2348031234567"
            />
            <Field label="Email" name="email" type="email" required />
            <Field label="Address" name="address" placeholder="Optional" />
            <Field
              label="Password"
              name="password"
              type="password"
              required
              hint="At least 8 characters"
            />
          </div>
        </Card>
      )}

      <Card>
        <h2 className="mb-3 font-semibold">Choose a unit</h2>
        {units.length === 0 ? (
          <p className="text-sm text-slate-500">
            No units are available in this project right now.
          </p>
        ) : (
          <div className="space-y-2">
            {units.map((unit, index) => (
              <label
                key={unit.id}
                className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-300 px-3 py-2"
              >
                <span className="flex items-center gap-3">
                  <input type="radio" name="unitId" value={unit.id} required defaultChecked={index === 0} />
                  <span>
                    <span className="block font-medium">
                      {unit.name} · Floor {unit.floor}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {unit.bedrooms} bed · {unit.sizeSqm} m²
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-sm font-medium">{unit.priceLabel}</span>
              </label>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <PlanPicker defaultTermMonths={defaultTermMonths} />
      </Card>

      <Submit disabled={units.length === 0} />
    </form>
  )
}
