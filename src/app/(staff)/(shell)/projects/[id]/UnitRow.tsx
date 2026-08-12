'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, ErrorText, Field } from '@/components/ui'
import { MediaImage } from '@/components/media'
import { MAX_RENDER_IMAGES } from '@/domain/media'
import { updateUnitAction } from '../actions'

interface UnitRowUnit {
  id: string
  name: string
  bedrooms: number
  sizeSqm: string
  status: 'AVAILABLE' | 'RESERVED' | 'SOLD'
  /** Non-null once a sale claims this unit — see below for why it is a sibling. */
  saleId: string | null
  priceLabel: string
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

export function UnitRow({
  projectId,
  unit,
  tone,
  editable
}: {
  projectId: string
  unit: UnitRowUnit
  tone: string
  editable: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [error, formAction] = useFormState(updateUnitAction, undefined)

  return (
    <li className="py-1">
      {/* The price-edit toggle and the sale link sit side by side rather than
          nested: an anchor inside a button is invalid HTML and neither control
          would be reliably operable. Both affordances stay reachable — an
          admin can still reprice a sold unit, and any staff member can open
          the sale from the same row. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => editable && setExpanded((value) => !value)}
          className={`flex min-h-11 flex-1 items-center justify-between gap-3 py-2 text-left ${
            editable ? '' : 'cursor-default'
          }`}
          aria-expanded={expanded}
          disabled={!editable}
        >
          {/* Only when a layout is set. A placeholder per row would put fifty
              dashed boxes down a fifty-unit floor and say nothing useful — the
              empty state that matters here is the one inside the edit form. */}
          {unit.layoutImageUrl ? (
            <span className="block w-12 shrink-0">
              <MediaImage
                kind="layout"
                src={unit.layoutImageUrl}
                alt={`Floor plan for unit ${unit.name}`}
                className="object-contain"
              />
            </span>
          ) : null}

          <span className="min-w-0">
            <span className="block font-medium">{unit.name}</span>
            <span className="block text-xs text-slate-500">
              {unit.bedrooms} bed · {unit.sizeSqm} m²
              {unit.renderImageUrls.length > 0
                ? ` · ${unit.renderImageUrls.length} render${
                    unit.renderImageUrls.length === 1 ? '' : 's'
                  }`
                : ''}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="text-sm text-slate-700">{unit.priceLabel}</span>
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
              {unit.status.charAt(0) + unit.status.slice(1).toLowerCase()}
            </span>
          </span>
        </button>

        {unit.saleId ? (
          <Link
            href={`/sales/${unit.saleId}`}
            className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium underline"
          >
            View sale
          </Link>
        ) : null}

        {/* The entry point to the whole staff sale flow. Staff sell and buyers
            view, so an available unit is sold from the inventory it is listed
            in. Both staff roles get the link — an agent selling units is the
            job description, and createSale authorizes the write itself. */}
        {unit.status === 'AVAILABLE' ? (
          <Link
            href={`/projects/${projectId}/sell/${unit.id}`}
            className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium underline"
          >
            Sell
          </Link>
        ) : null}
      </div>

      {editable && expanded ? (
        <form action={formAction} className="space-y-3 pb-3">
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
              className="w-full rounded-lg border border-slate-300 p-3 font-mono text-sm outline-none focus:border-slate-900"
            />
          </Field>

          {unit.renderImageUrls.length > 0 ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {unit.renderImageUrls.map((url, index) => (
                <li key={url}>
                  <MediaImage
                    kind="render"
                    src={url}
                    alt={`Render ${index + 1} of ${unit.renderImageUrls.length} for unit ${unit.name}`}
                  />
                </li>
              ))}
            </ul>
          ) : null}

          <SaveButton />
        </form>
      ) : null}
    </li>
  )
}
