'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { changePasswordAction } from '@/server/actions/passwords'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full sm:w-auto">
      {pending ? 'Changing…' : 'Change password'}
    </Button>
  )
}

/**
 * One form for staff and buyers. The two account pages differ only in their
 * guard and their shell, so the fields, the copy and the sign-out-afterwards
 * behaviour are shared rather than written twice.
 */
export function ChangePasswordForm() {
  const [error, formAction] = useFormState(changePasswordAction, undefined)

  return (
    <Card>
      <form action={formAction} className="space-y-4">
        <ErrorText>{error}</ErrorText>

        <Field label="Current password" name="currentPassword" type="password" required />
        <Field
          label="New password"
          name="password"
          type="password"
          required
          hint="At least 8 characters."
        />
        <Field label="Confirm new password" name="confirmation" type="password" required />

        <p className="text-xs text-slate-500">
          Changing your password signs you out everywhere, including here. You will be asked to
          sign in again with the new one.
        </p>

        <Submit />
      </form>
    </Card>
  )
}
