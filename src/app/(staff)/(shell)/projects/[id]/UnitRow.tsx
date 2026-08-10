'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, ErrorText, Field } from '@/components/ui'
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
          <span className="min-w-0">
            <span className="block font-medium">{unit.name}</span>
            <span className="block text-xs text-slate-500">
              {unit.bedrooms} bed · {unit.sizeSqm} m²
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

          <SaveButton />
        </form>
      ) : null}
    </li>
  )
}
