'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { PasswordField } from '@/components/PasswordField'
import { createAgentAction } from './actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full sm:w-auto">
      {pending ? 'Adding…' : 'Add agent'}
    </Button>
  )
}

export function AddAgentForm() {
  const [error, formAction] = useFormState(createAgentAction, undefined)

  return (
    <Card>
      <h2 className="mb-3 text-base font-semibold text-navy-900">Add sales agent</h2>
      {/* Resets the uncontrolled inputs after a successful add — a fresh key
          on submit success would work too, but formAction returning undefined
          on success (see createAgentAction) means the form simply keeps
          whatever the browser leaves in the fields until the next navigation.
          Values are not persisted, so a repeat accidental submit costs
          nothing beyond retyping. */}
      <form action={formAction} className="space-y-4">
        <ErrorText>{error}</ErrorText>

        <Field label="Full name" name="fullName" required placeholder="Chidi Okeke" />
        <Field label="Email" name="email" type="email" required placeholder="chidi@sunrise.test" />
        <PasswordField
          label="Temporary password"
          name="password"
          required
          placeholder="At least 8 characters"
          hint="Share this with your agent — they can sign in with it immediately, then change it from their profile."
        />

        <Submit />
      </form>
    </Card>
  )
}
