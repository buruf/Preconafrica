'use client'

import { useState, useTransition } from 'react'
import { Button, ErrorText } from '@/components/ui'
import { setSuspendedAction } from '../../actions'

/**
 * Suspending asks first; lifting a suspension does not.
 *
 * The asymmetry is deliberate. Suspending locks a developer's whole staff out
 * on their next click, which is the kind of thing that should not happen from
 * one mis-aimed tap. Restoring access has no victim, so a confirmation there
 * would be ceremony.
 */
export function SuspendButton({
  orgId,
  developerName,
  suspended
}: {
  orgId: string
  developerName: string
  suspended: boolean
}) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | undefined>()

  function run() {
    if (!suspended) {
      const ok = window.confirm(
        `Suspend ${developerName}? Their staff will be signed out on their next action. ` +
          `Their buyers keep access to the documents they already hold, and nothing is deleted.`
      )
      if (!ok) return
    }

    start(async () => {
      setError(await setSuspendedAction(orgId, !suspended))
    })
  }

  return (
    <div>
      <Button type="button" variant={suspended ? 'primary' : 'danger'} onClick={run} disabled={pending}>
        {pending ? 'Saving…' : suspended ? 'Lift suspension' : 'Suspend developer'}
      </Button>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
