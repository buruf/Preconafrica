'use client'

import { useId, useState } from 'react'

/**
 * A password input that is masked by default and can be revealed deliberately.
 *
 * Both places this is used are staff setting a temporary password to hand to
 * someone else — a new agent, or a buyer being registered at a desk. That is
 * exactly the situation where the value ends up on screen in a sales office
 * with the buyer, their family, and whoever else is in the room able to read
 * it, and it is the staff member's own working password habits that suffer
 * when an app teaches them passwords are ordinary text.
 *
 * Masked-with-a-toggle rather than plain `type="password"` because the person
 * typing it genuinely does need to read it back aloud. The difference is that
 * revealing becomes a deliberate act for the couple of seconds it takes,
 * instead of the default state of the screen.
 */
export function PasswordField({
  label,
  name,
  required,
  placeholder,
  hint
}: {
  label: string
  name: string
  required?: boolean
  placeholder?: string
  hint?: string
}) {
  const [revealed, setRevealed] = useState(false)
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-muted">
        {label}
        {required ? <span className="text-overdue-text"> *</span> : null}
      </label>

      <div className="relative">
        <input
          id={id}
          name={name}
          // Masked by default. `text` only while explicitly revealed.
          type={revealed ? 'text' : 'password'}
          required={required}
          placeholder={placeholder}
          aria-describedby={hintId}
          // Never offer to save or autofill a password being minted for
          // somebody else — it is not the staff member's own credential.
          autoComplete="new-password"
          className="min-h-11 w-full rounded-[10px] border border-line bg-surface pl-3 pr-16 text-[15px] text-ink outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
        />
        <button
          type="button"
          onClick={() => setRevealed((value) => !value)}
          // Inside the field's padding, so it never widens the row or steals a
          // tap from the input itself.
          className="absolute inset-y-0 right-0 flex min-h-11 items-center px-3 text-[13px] font-medium text-teal-500"
          aria-pressed={revealed}
        >
          {revealed ? 'Hide' : 'Show'}
        </button>
      </div>

      {hint ? (
        <p id={hintId} className="mt-1 text-[13px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
