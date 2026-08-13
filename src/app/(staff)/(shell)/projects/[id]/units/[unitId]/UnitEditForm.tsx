'use client'

import { useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { MAX_RENDER_IMAGES } from '@/domain/media'
import { updateUnitAction } from '../../../actions'

/**
 * The admin's unit-edit form, lifted out of the old inventory row.
 *
 * It is the same six fields against the same action; what changed is where it
 * lives. Inside a list row it had to be collapsible or fifty units meant fifty
 * forms, and the two URL fields — the ones that put a floor plan and renders on
 * the buyer's dashboard — were the least discoverable controls in the app. On
 * the unit's own screen there is exactly one form, directly under the imagery it
 * changes.
 *
 * Still collapsed by default, for a different reason: staff open this screen to
 * sell a unit far more often than to reprice one, and the primary action should
 * not be pushed below six inputs.
 */

interface EditableUnit {
  id: string
  name: string
  bedrooms: number
  sizeSqm: string
  priceInput: string
  layoutImageUrl: string | null
  renderImageUrls: string[]
}

function SaveButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full sm:w-auto">
      {pending ? 'Saving…' : 'Save'}
    </Button>
  )
}

export function UnitEditForm({
  projectId,
  unit
}: {
  projectId: string
  unit: EditableUnit
}) {
  const [open, setOpen] = useState(false)
  const [error, formAction] = useFormState(updateUnitAction, undefined)

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-base font-semibold text-navy-900">Edit unit details</span>
        <span className="text-[13px] font-medium text-muted">{open ? 'Close' : 'Open'}</span>
      </button>

      {open ? (
        <form action={formAction} className="mt-3 space-y-3">
          <input type="hidden" name="unitId" value={unit.id} />
          <input type="hidden" name="projectId" value={projectId} />

          <ErrorText>{error}</ErrorText>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" name="name" defaultValue={unit.name} />
            <Field label="Bedrooms" name="bedrooms" type="number" defaultValue={unit.bedrooms} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Size (m²)" name="sizeSqm" defaultValue={unit.sizeSqm} />
            <Field label="Price" name="price" defaultValue={unit.priceInput} />
          </div>

          <Field
            label="Layout (floor plan) URL"
            name="layoutImageUrl"
            type="url"
            defaultValue={unit.layoutImageUrl ?? ''}
            placeholder="https://…/unit-3b-plan.png"
            hint="An https link to a PNG or JPEG. Empty removes it."
          />

          {/* A textarea, one URL per line: several renders per unit, entered the
              way anyone would paste them out of a folder listing or a
              spreadsheet column. `parseRenderUrls` trims, drops blank lines,
              de-duplicates and refuses the whole submission if any line is not a
              usable https URL — named by line number, because "one of these is
              wrong" is not an actionable error. */}
          <Field
            label="Render URLs"
            name="renderImageUrls"
            hint={`One https URL per line, up to ${MAX_RENDER_IMAGES}. Empty removes them all.`}
          >
            <textarea
              name="renderImageUrls"
              rows={3}
              defaultValue={unit.renderImageUrls.join('\n')}
              placeholder={'https://…/living.jpg\nhttps://…/kitchen.jpg'}
              // text-base for the same reason `Field`'s input uses it: anything
              // under 16px makes iOS Safari zoom the page on focus.
              className="w-full rounded-btn border border-line bg-surface p-3 font-mono text-base text-ink outline-none placeholder:text-muted focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </Field>

          <SaveButton />
        </form>
      ) : null}
    </Card>
  )
}
