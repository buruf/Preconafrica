'use client'

import { useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Button, ErrorText } from '@/components/ui'
import { deactivateAgentAction } from './actions'

function ConfirmButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="danger" disabled={pending} className="w-full sm:w-auto">
      {pending ? 'Deactivating…' : 'Confirm deactivate'}
    </Button>
  )
}

/**
 * Only ever rendered by the parent page for active AGENT rows (see
 * page.tsx) — ADMIN rows never get this control, and the page is ADMIN-only
 * to begin with. The real gate is deactivateAgentAction's requireAdmin() and
 * the service's own role/self checks, not this component's visibility.
 * Collapsed by default so deactivation is always a deliberate second tap.
 */
export function DeactivateControl({ userId }: { userId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [error, formAction] = useFormState(deactivateAgentAction, undefined)

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="inline-flex min-h-11 items-center text-sm font-medium text-rose-700 underline"
      >
        Deactivate
      </button>
    )
  }

  return (
    <form action={formAction} className="w-full space-y-2 sm:w-56">
      <input type="hidden" name="userId" value={userId} />
      <ErrorText>{error}</ErrorText>
      <p className="text-xs text-slate-500">
        They will no longer be able to sign in. This cannot be undone here.
      </p>
      <div className="flex gap-2">
        <ConfirmButton />
        <Button type="button" variant="secondary" onClick={() => setExpanded(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
