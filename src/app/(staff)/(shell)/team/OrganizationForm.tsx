'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { MediaImage } from '@/components/media'
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
 * current one is shown beside the box — an admin who pastes a URL should see
 * immediately whether it is the mark they meant, rather than issuing an invoice
 * to find out.
 *
 * Clearing the box and saving removes the logo and puts the initials back.
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
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Organisation</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[8rem_1fr] sm:items-start">
        <div className="w-32">
          <MediaImage
            kind="layout"
            src={logoUrl}
            alt={`${orgName} logo`}
            label="No logo"
            className="!aspect-square object-contain"
          />
        </div>

        <form action={formAction} className="space-y-4">
          <ErrorText>{error}</ErrorText>

          <Field
            label="Logo URL"
            name="logoUrl"
            type="url"
            defaultValue={logoUrl ?? ''}
            placeholder="https://…/logo.png"
            hint="An https link to a PNG or JPEG. It heads every invoice; leave it empty to print your initials instead."
          />

          <Submit />
        </form>
      </div>
    </Card>
  )
}
