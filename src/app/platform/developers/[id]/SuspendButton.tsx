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
 *
 * The reason is optional but worth giving: it is shown verbatim to that
 * developer's staff on the screen they hit when they try to work, and it lands
 * in their own audit log where they can still read it afterwards. Without one
 * they are locked out with nothing to go on — which is how this shipped the
 * first time, and the gap this replaces a `window.confirm` to close.
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
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')

  function apply(nextSuspended: boolean, why?: string) {
    start(async () => {
      setError(await setSuspendedAction(orgId, nextSuspended, why))
      setAsking(false)
      setReason('')
    })
  }

  if (suspended) {
    return (
      <div>
        <Button type="button" onClick={() => apply(false)} disabled={pending}>
          {pending ? 'Saving…' : 'Lift suspension'}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    )
  }

  if (!asking) {
    return (
      <div>
        <Button type="button" variant="danger" onClick={() => setAsking(true)} disabled={pending}>
          Suspend developer
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    )
  }

  return (
    <div>
      <p className="mb-2 text-sm text-ink">
        Suspend <span className="font-semibold">{developerName}</span>? Their staff are signed out
        on their next action. Their buyers keep access to the documents they already hold, and
        nothing is deleted.
      </p>

      <label className="block text-sm font-medium text-ink" htmlFor="suspend-reason">
        Reason <span className="font-normal text-muted">(optional — they will see this)</span>
      </label>
      <textarea
        id="suspend-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={3}
        maxLength={500}
        placeholder="e.g. Subscription unpaid since June."
        className="mb-3 mt-1 w-full rounded-lg border border-line p-3 text-base text-ink"
      />

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="danger"
          onClick={() => apply(true, reason)}
          disabled={pending}
        >
          {pending ? 'Suspending…' : 'Suspend'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setAsking(false)
            setReason('')
            setError(undefined)
          }}
        >
          Cancel
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
