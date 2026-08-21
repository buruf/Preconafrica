'use client'

import { useState, useTransition } from 'react'
import { Button, ErrorText } from '@/components/ui'
import { deleteDeveloperAction } from '../../actions'

/**
 * Only rendered for a developer with nothing in it, and it still asks — the
 * name has to be typed back.
 *
 * That is not ceremony for its own sake. This is the one irreversible control
 * in the console: `Organization.users` cascades, so confirming takes the admin
 * account with it, and there is no undo. Typing the name is the difference
 * between meaning it and mis-tapping while scrolling on a phone.
 *
 * The server checks emptiness again regardless of what this component believes
 * — it is the authority, and a page loaded a minute ago is not.
 */
export function DeleteButton({ orgId, developerName }: { orgId: string; developerName: string }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | undefined>()
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')

  if (!confirming) {
    return (
      <div>
        <Button type="button" variant="danger" onClick={() => setConfirming(true)}>
          Delete developer
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    )
  }

  return (
    <div>
      <p className="mb-2 text-sm text-ink">
        Type <span className="font-semibold">{developerName}</span> to confirm. This removes the
        organisation and its administrator account, and cannot be undone.
      </p>
      <input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        aria-label={`Type ${developerName} to confirm deletion`}
        className="mb-3 min-h-11 w-full rounded-lg border border-line px-3 text-base text-ink"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="danger"
          disabled={pending || typed.trim() !== developerName}
          onClick={() =>
            start(async () => {
              // A successful delete redirects, so nothing comes back and this
              // never sets state. Only a refusal returns a message.
              setError(await deleteDeveloperAction(orgId))
            })
          }
        >
          {pending ? 'Deleting…' : 'Delete permanently'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setConfirming(false)
            setTyped('')
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
