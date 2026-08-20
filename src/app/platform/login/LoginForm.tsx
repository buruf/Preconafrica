'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { platformLoginAction } from './actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  )
}

export function PlatformLoginForm() {
  const [error, formAction] = useFormState(platformLoginAction, undefined)

  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold text-navy-900">Platform sign in</h1>
      <p className="mb-4 text-sm text-muted">For whoever runs PreCon Africa.</p>
      <form action={formAction} className="space-y-4">
        {/* One message for every failure — this form guards the account that
            can create and suspend every developer, so it must not reveal which
            addresses belong to operators. */}
        <ErrorText>{error}</ErrorText>
        <Field label="Email" name="email" type="email" required />
        <Field label="Password" name="password" type="password" required />
        <Submit />
      </form>
    </Card>
  )
}
