'use client'

import { useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, ErrorText, Field } from '@/components/ui'
import { updateProjectImageryAction } from '../actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full sm:w-auto">
      {pending ? 'Saving…' : 'Save photo'}
    </Button>
  )
}

/**
 * The smallest honest project-edit surface: one field, one action, folded under
 * the banner it changes. There is no project settings page in this app, and
 * inventing one to hold a single URL would be the wrong size of change — but
 * without any edit path at all, only projects created after today could ever
 * have a photo.
 *
 * Collapsed by default so the inventory (which is what staff came here for) is
 * not pushed down the page by a form nobody opens twice.
 */
export function HeroImageForm({
  projectId,
  heroImageUrl
}: {
  projectId: string
  heroImageUrl: string | null
}) {
  const [open, setOpen] = useState(false)
  const [error, formAction] = useFormState(
    updateProjectImageryAction.bind(null, projectId),
    undefined
  )

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex min-h-11 items-center text-sm font-medium text-slate-600 underline"
      >
        {heroImageUrl ? 'Change the building photo' : 'Add a building photo'}
      </button>

      {open ? (
        <form action={formAction} className="mt-2 space-y-3">
          <ErrorText>{error}</ErrorText>

          <Field
            label="Building photo URL"
            name="heroImageUrl"
            type="url"
            defaultValue={heroImageUrl ?? ''}
            placeholder="https://…/sunrise-heights.jpg"
            hint="An https link to a PNG or JPEG. Leave it empty and save to remove the photo."
          />

          <Submit />
        </form>
      ) : null}
    </div>
  )
}
