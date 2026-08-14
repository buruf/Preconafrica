'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText } from '@/components/ui'
import { ImagePicker } from '@/components/ImagePicker'
import { updateOrganizationLogoAction } from './actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full sm:w-auto">
      {pending ? 'Saving…' : 'Save logo'}
    </Button>
  )
}

/**
 * One field, because one field is all the organisation record has that an admin
 * can usefully change today. The logo prints on every invoice, which is why the
 * current one is shown beside the picker — an admin who sets it should see
 * immediately whether it is the mark they meant, rather than issuing an invoice
 * to find out.
 *
 * Uploaded rather than pasted, since the mark almost never has a public URL: it
 * is a file in somebody's brand folder. It is stored small (512px long edge) and
 * as a PNG, both on purpose — the mark is drawn at 128px here and at 46pt in a
 * PDF masthead, and the PDF pipeline embeds PNG and JPEG only, so a WebP logo
 * would look right on this page and print as the initials placeholder on every
 * invoice. PNG also keeps a transparent background transparent.
 *
 * Removing the logo and saving puts the initials back.
 */
export function OrganizationForm({
  orgName,
  logoUrl
}: {
  orgName: string
  logoUrl: string | null
}) {
  const [error, formAction] = useFormState(updateOrganizationLogoAction, undefined)

  return (
    <Card>
      <h2 className="mb-3 text-base font-semibold text-navy-900">Organisation</h2>

      <form action={formAction} className="space-y-4">
        <ErrorText>{error}</ErrorText>

        <ImagePicker
          name="logoUrl"
          label="Logo"
          previewAlt={`${orgName} logo`}
          uploadKind="logo"
          previewKind="layout"
          previewLabel="No logo"
          previewClassName="!aspect-square object-contain"
          initialUrl={logoUrl}
          pickLabel="Choose a logo"
          hint="A PNG, JPEG or WebP. It heads every invoice; remove it and save to print your initials instead."
        />

        <Submit />
      </form>
    </Card>
  )
}
