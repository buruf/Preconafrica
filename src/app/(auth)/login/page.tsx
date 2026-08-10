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

export default function LoginPage() {
  const [error, formAction] = useFormState(loginAction, undefined)

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-5">
      <h1 className="mb-1 text-2xl font-semibold">Sign in</h1>
      <p className="mb-5 text-sm text-slate-500">Developers, agents and buyers.</p>

      <Card>
        <form action={formAction} className="space-y-4">
          <ErrorText>{error}</ErrorText>
          <Field label="Email" name="email" type="email" required />
          <Field label="Password" name="password" type="password" required />
          <Submit />
        </form>
      </Card>
    </main>
  )
}
