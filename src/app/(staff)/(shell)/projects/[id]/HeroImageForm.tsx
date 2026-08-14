'use client'

import { useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, ErrorText } from '@/components/ui'
import { ImagePicker } from '@/components/ImagePicker'
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
 * inventing one to hold a single image would be the wrong size of change — but
 * without any edit path at all, only projects created after today could ever
 * have a photo.
 *
 * Collapsed by default so the inventory (which is what staff came here for) is
 * not pushed down the page by a form nobody opens twice.
 *
 * The field is now `ImagePicker`: a developer standing in front of the building
 * picks the photo off their phone. The pasted-link box is still there, one tap
 * away, and the action, the schema and the column are untouched — what the form
 * submits is the same single URL string it always did.
 */
export function HeroImageForm({
  projectId,
  heroImageUrl,
  projectName
}: {
  projectId: string
  heroImageUrl: string | null
  projectName: string
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
        className="inline-flex min-h-11 items-center text-sm font-semibold text-muted underline"
      >
        {heroImageUrl ? 'Change the building photo' : 'Add a building photo'}
      </button>

      {open ? (
        <form action={formAction} className="mt-2 space-y-3">
          <ErrorText>{error}</ErrorText>

          <ImagePicker
            name="heroImageUrl"
            label="Building photo"
            previewAlt={`${projectName} building photo`}
            uploadKind="building"
            previewKind="building"
            initialUrl={heroImageUrl}
            projectId={projectId}
            hint="A PNG, JPEG or WebP from your phone or computer. Remove it and save to clear the photo."
          />

          <Submit />
        </form>
      ) : null}
    </div>
  )
}
