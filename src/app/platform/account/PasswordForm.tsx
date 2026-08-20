'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { changePlatformPasswordAction } from '../actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Changing…' : 'Change password'}
    </Button>
  )
}

export function PlatformPasswordForm() {
  const [error, formAction] = useFormState(changePlatformPasswordAction, undefined)

  return (
    <Card>
      <form action={formAction} className="space-y-4">
        <ErrorText>{error}</ErrorText>
        <Field label="Current password" name="currentPassword" type="password" required />
        <Field
          label="New password"
          name="newPassword"
          type="password"
          required
          hint="At least 8 characters. Changing it signs out every other session, including any opened with your temporary password."
        />
        <Submit />
      </form>
    </Card>
  )
}
