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

export default function NewProjectPage() {
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

          <div className="grid grid-cols-3 gap-3">
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

          <div className="grid grid-cols-3 gap-3">
            <Field label="Bedrooms" name="defaultBedrooms" type="number" required defaultValue={2} />
            <Field label="Size (m²)" name="defaultSizeSqm" required defaultValue="90.00" />
            <Field label="Price" name="defaultPrice" required placeholder="145000000" />
          </div>

          <div className="grid grid-cols-2 gap-3">
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
