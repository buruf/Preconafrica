import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Notice, NOTICE_TONE, type ActionResult } from '@/components/ui'

/**
 * The fix for the actual root cause.
 *
 * Every action on the staff sale page used to answer with a string when
 * something went wrong and `undefined` when it worked, so a successful
 * recording rendered nothing whatsoever — and a form that looks untouched
 * after you press its button invites you to press it again. That is how one
 * $50,000 deposit was recorded twice.
 *
 * So there are two things to hold: a success must render, and it must not
 * render as a failure. Both are asserted against real markup rather than
 * against the tone table alone, because "the component picks the right class"
 * and "the component shows the message at all" are separate failures.
 */
const success: ActionResult = { ok: true, message: 'Recorded NGN 50,000.00 against the deposit. Receipt RCP-000031.' }
const failure: ActionResult = { ok: false, message: 'Installment 2 has NGN 250.00 outstanding — enter that amount or less.' }

const render = (result?: ActionResult) => renderToStaticMarkup(createElement(Notice, { result }))

describe('Notice', () => {
  it('renders a success message', () => {
    const html = render(success)
    expect(html).toContain('Receipt RCP-000031')
    expect(html).toContain('role="status"')
  })

  it('renders a failure message', () => {
    expect(render(failure)).toContain('outstanding')
  })

  it('draws success and failure in visibly different palettes', () => {
    const ok = render(success)
    const error = render(failure)

    // Success in the Available/Paid green, failure in the Overdue red — the
    // two triples from DESIGN.md's status table, never mixed.
    expect(ok).toContain(NOTICE_TONE.ok)
    expect(ok).not.toContain('status-overdue')
    expect(error).toContain(NOTICE_TONE.error)
    expect(error).not.toContain('status-paid')
    expect(ok).not.toBe(error)
  })

  it('renders nothing at all before an action has run', () => {
    // Only *before*. There is no path back to this state after a submit:
    // every action on that page now returns a result either way.
    expect(render(undefined)).toBe('')
  })
})
