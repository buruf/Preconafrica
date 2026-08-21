'use client'

import Link from 'next/link'
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
      <p className="mb-1 text-sm text-muted">
        For whoever runs PreCon Africa — not for developers or buyers.
      </p>
      {/* The pointer that matters most, because this is where the wrong person
          ends up. A developer's admin is handed credentials by this console and
          the natural move is to try them right here, where they are refused —
          the login is deliberately vague about *why*, so without this line
          there is nothing to go on. A plain link costs nothing: /login is not
          a secret, and the security here is the credential check, never the
          obscurity of the address. */}
      <p className="mb-4 text-sm text-muted">
        Developers and buyers sign in at{' '}
        <Link href="/login" className="font-semibold text-navy-900 underline">
          /login
        </Link>
        .
      </p>
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
