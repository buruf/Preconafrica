'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field, PageHeader } from '@/components/ui'
import { SUPPORTED_CURRENCIES } from '@/domain/currency'
import { UNIT_PATTERN_PRESETS } from '@/domain/units'
import { createProjectAction } from '../actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Creating…' : 'Create project'}
    </Button>
  )
}

export function NewProjectForm() {
  const [error, formAction] = useFormState(createProjectAction, undefined)

  return (
    <>
      <PageHeader title="New project" />

      <Card>
        <form action={formAction} className="space-y-4">
          <ErrorText>{error}</ErrorText>

          <Field label="Building name" name="name" required placeholder="Sunrise Heights" />
          <Field label="Location" name="location" required placeholder="Lekki Phase 1, Lagos" />

          <Field
            label="Currency"
            name="currency"
            required
            hint="Prices for this project are set and displayed in this currency."
          >
            <select
              name="currency"
              required
              className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base"
            >
              {Object.keys(SUPPORTED_CURRENCIES).map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Expected completion" name="expectedCompletion" type="date" required />

          <Field
            label="Building photo URL"
            name="heroImageUrl"
            type="url"
            placeholder="https://…/sunrise-heights.jpg"
            hint="Optional — an https link to a photo or render of the building. It heads the inventory page and the buyer's statement, and can be added later from that page."
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Floors" name="floors" type="number" required defaultValue={4} />
            <Field label="Units / floor" name="unitsPerFloor" type="number" required defaultValue={6} />
            <Field label="First floor no." name="startFloor" type="number" required defaultValue={1} />
          </div>

          <Field
            label="Unit naming pattern"
            name="namingPattern"
            required
            hint="{floor} is the floor number, {index:02} a zero-padded count, {letter} a letter."
          >
            <select
              name="namingPattern"
              className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base"
            >
              {UNIT_PATTERN_PRESETS.map((preset) => (
                <option key={preset.pattern} value={preset.pattern}>
                  {preset.label}
                </option>
              ))}
            </select>
          </Field>

          <p className="text-xs text-slate-500">
            These apply to every generated unit. Edit individual units afterwards.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Bedrooms" name="defaultBedrooms" type="number" required defaultValue={2} />
            <Field label="Size (m²)" name="defaultSizeSqm" required defaultValue="90.00" />
            <Field label="Price" name="defaultPrice" required placeholder="145000000" />
          </div>

          {/* Two modes, not one with a workaround. A percentage of the financed
              amount is interest, and interest is not permissible in several of
              the markets this platform is sold into — a developer there charges
              one flat fee for the service of spreading the payments. See
              `InstallmentFeeMode` in schema.prisma. */}
          <Field
            label="How installments are charged"
            name="installmentFeeMode"
            hint="A percentage of the financed amount, or one flat amount whatever the unit costs. Choose a fixed amount where charging interest is not permissible."
          >
            <select
              name="installmentFeeMode"
              className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base"
            >
              <option value="PERCENT">A percentage of the financed amount</option>
              <option value="FIXED">A fixed amount</option>
            </select>
          </Field>

          <Field
            label="Installment charge (%)"
            name="installmentMarkupPercent"
            defaultValue="0"
            placeholder="10"
            hint="Used when the charge is a percentage. Charged on the financed amount (price less deposit). Up to two decimal places. Staff can override it on an individual sale."
          />

          <Field
            label="Fixed installment charge"
            name="installmentFixedFee"
            defaultValue="0"
            placeholder="2500000"
            hint="Used when the charge is a fixed amount. In the project's own currency, and it must be less than the amount a buyer finances. Staff can override it on an individual sale."
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Remind days before"
              name="reminderDaysBefore"
              type="number"
              required
              defaultValue={7}
            />
            <Field
              label="Overdue notice after"
              name="overdueNoticeDaysAfter"
              type="number"
              required
              defaultValue={3}
            />
          </div>

          <Submit />
        </form>
      </Card>
    </>
  )
}
