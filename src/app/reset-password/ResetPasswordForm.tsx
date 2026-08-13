'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { resetPasswordAction } from './actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Saving…' : 'Set new password'}
    </Button>
  )
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [error, formAction] = useFormState(resetPasswordAction, undefined)

  return (
    <Card>
      {/* Heading inside the card, matching login and /forgot-password. */}
      <h1 className="mb-1 text-xl font-semibold text-navy-900">Choose a new password</h1>
      <p className="mb-4 text-[13px] text-muted">
        Then sign in with it — you will not need this link again.
      </p>
      <form action={formAction} className="space-y-4">
        <ErrorText>{error}</ErrorText>
        {/* The token travels in a hidden field rather than being re-read from
            the URL on the server: the action is a POST to the app, not to
            this page's route, so the query string is not part of it. */}
        <input type="hidden" name="token" value={token} />
        <Field
          label="New password"
          name="password"
          type="password"
          required
          hint="At least 8 characters."
        />
        <Field label="Confirm new password" name="confirmation" type="password" required />
        <Submit />
      </form>
    </Card>
  )
}
