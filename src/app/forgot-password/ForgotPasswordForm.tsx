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
      {/* The heading lives inside the card, as it does on the login page — these
          two screens are the product's entire public surface and they should
          read as one thing. */}
      <h1 className="mb-1 text-xl font-semibold text-navy-900">Reset your password</h1>
      <p className="mb-4 text-[13px] text-muted">
        Enter the email address you sign in with and we will send you a link.
      </p>
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
