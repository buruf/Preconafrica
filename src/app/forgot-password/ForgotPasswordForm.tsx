'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { requestPasswordResetAction } from './actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Sending…' : 'Send reset link'}
    </Button>
  )
}

export function ForgotPasswordForm() {
  const [error, formAction] = useFormState(requestPasswordResetAction, undefined)

  return (
    <Card>
      <form action={formAction} className="space-y-4">
        <ErrorText>{error}</ErrorText>
        <Field
          label="Email"
          name="email"
          type="email"
          required
          placeholder="you@example.com"
        />
        <Submit />
      </form>
    </Card>
  )
}
