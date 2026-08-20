'use client'

import { useFormState, useFormStatus } from 'react-dom'
import Link from 'next/link'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { createDeveloperAction } from '../../actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Creating…' : 'Create developer'}
    </Button>
  )
}

export function NewDeveloperForm() {
  const [state, formAction] = useFormState(createDeveloperAction, undefined)

  // The one screen the temporary password is ever shown on. It is not stored
  // in readable form anywhere, so there is no second chance to read it — which
  // is why this replaces the form rather than appearing beside it.
  if (state?.ok) {
    return (
      <Card>
        <h1 className="text-lg font-semibold text-ink">Developer created</h1>
        <p className="mt-2 text-sm text-muted">
          Give these to their administrator. The password is shown once and is not stored
          anywhere it can be read again.
        </p>
        <dl className="mt-4 space-y-2 rounded-xl border border-line bg-page p-3">
          <div>
            <dt className="text-xs text-muted">Email</dt>
            <dd className="break-all font-semibold text-ink">{state.adminEmail}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Temporary password</dt>
            <dd className="break-all font-mono text-base font-semibold text-ink">
              {state.temporaryPassword}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">
          Ask them to change it once they are in. Doing so ends every session opened with
          this password, including anyone who saw it over a shoulder.
        </p>
        <Link
          href="/platform"
          className="mt-4 inline-flex min-h-11 items-center font-semibold text-navy-900 underline"
        >
          Back to developers
        </Link>
      </Card>
    )
  }

  return (
    <Card>
      <form action={formAction} className="space-y-4">
        <ErrorText>{state?.ok === false ? state.error : undefined}</ErrorText>
        <Field label="Developer name" name="name" required placeholder="Khaleel Homes" />
        <Field
          label="Short name"
          name="slug"
          required
          placeholder="khaleel"
          hint="Lowercase letters, numbers and hyphens. Used in links and cannot be changed later."
        />
        <div className="border-t border-line pt-4">
          <h2 className="text-sm font-semibold text-ink">Their administrator</h2>
          <p className="mb-3 text-xs text-muted">
            The first account for this developer. They can add their own agents afterwards.
          </p>
          <div className="space-y-4">
            <Field label="Full name" name="adminFullName" required />
            <Field label="Email" name="adminEmail" type="email" required />
          </div>
        </div>
        <Submit />
      </form>
    </Card>
  )
}
