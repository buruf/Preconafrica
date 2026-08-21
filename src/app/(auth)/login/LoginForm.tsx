'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { loginAction } from './actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  )
}

export function LoginForm() {
  const [error, formAction] = useFormState(loginAction, undefined)

  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold text-navy-900">Sign in</h1>
      {/* Which door this is. There are two — this and the platform console —
          and unlabelled, nothing on either screen told you which account
          belonged where. The first developer admin ever created was handed
          credentials by the console and tried them on the console, which
          refuses them. Naming the audience is enough: buyers and a developer's
          staff share this door, and neither needs to know the other exists. */}
      <p className="mb-4 text-sm text-muted">For developers and buyers.</p>
      <form action={formAction} className="space-y-4">
        {/* One message for every failure, on purpose: "no such account" and
            "wrong password" must be indistinguishable or the form becomes an
            account-enumeration oracle. See loginAction. */}
        <ErrorText>{error}</ErrorText>
        <Field label="Email" name="email" type="email" required />
        <Field label="Password" name="password" type="password" required />
        <Submit />
      </form>
    </Card>
  )
}
