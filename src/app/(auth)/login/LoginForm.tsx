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
      <form action={formAction} className="space-y-4">
        <ErrorText>{error}</ErrorText>
        <Field label="Email" name="email" type="email" required />
        <Field label="Password" name="password" type="password" required />
        <Submit />
      </form>
    </Card>
  )
}
