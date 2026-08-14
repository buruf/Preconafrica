'use client'

import { useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { ImagePicker, ImagePickerList } from '@/components/ImagePicker'
import { MAX_RENDER_IMAGES } from '@/domain/media'
import { updateUnitAction } from '../../../actions'

/**
 * The admin's unit-edit form, lifted out of the old inventory row.
 *
 * It is the same six fields against the same action; what changed is where it
 * lives. Inside a list row it had to be collapsible or fifty units meant fifty
 * forms, and the two imagery fields — the ones that put a floor plan and renders
 * on the buyer's dashboard — were the least discoverable controls in the app. On
 * the unit's own screen there is exactly one form, directly under the imagery it
 * changes.
 *
 * Those two are now file pickers rather than URL boxes: an admin exporting plans
 * out of a drawing package picks the files. A pasted link is still accepted,
 * folded under each control, and the action and the schemas behind them are
 * untouched — one string for the plan, one newline-separated string for the
 * renders, exactly as before.
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

          {/* The floor plan has its own encoding profile on the server — a
              larger pixel cap and PNG first — because it is the one image here
              made of thin lines and small room labels a buyer has to read. */}
          <ImagePicker
            name="layoutImageUrl"
            label="Layout (floor plan)"
            previewAlt={`Floor plan for unit ${unit.name}`}
            uploadKind="layout"
            previewKind="layout"
            previewClassName="object-contain"
            initialUrl={unit.layoutImageUrl}
            projectId={projectId}
            unitId={unit.id}
            pickLabel="Choose a floor plan"
            hint="A PNG, JPEG or WebP export of the plan. Remove it and save to clear it."
          />

          {/* Several renders per unit, picked in one go, in the order they were
              picked, each removable on its own. The value submitted is still the
              newline-separated string `parseRenderUrls` has always parsed — it
              trims, drops blanks, de-duplicates and enforces the cap on the
              server, however the URLs got into the field. */}
          <ImagePickerList
            name="renderImageUrls"
            label="Renders"
            max={MAX_RENDER_IMAGES}
            initialUrls={unit.renderImageUrls}
            projectId={projectId}
            unitId={unit.id}
            altPrefix={`Artist's impression of unit ${unit.name}`}
            hint={`Up to ${MAX_RENDER_IMAGES}. Remove them all and save to clear the gallery.`}
          />

          <SaveButton />
        </form>
      ) : null}
    </Card>
  )
}
