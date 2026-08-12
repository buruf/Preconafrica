import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The action layer had no tests at all, which is where two of this flow's
 * guarantees actually live:
 *
 *   1. /forgot-password answers identically for every outcome. The service is
 *      written so the caller has nothing to leak — but the *caller* is what
 *      decides where the browser ends up, and it is one stray early return
 *      away from being an enumeration oracle. Same target, same wall-clock
 *      time, for a real user, an unknown address, a throttled address and a
 *      send that blew up.
 *   2. changePasswordAction takes the user id from the session and nowhere
 *      else. A FormData field is attacker-controlled; if one ever reached
 *      `changePassword`, this would be a "change anybody's password" endpoint
 *      for anyone signed in.
 *
 * Everything under the actions is mocked: these tests are about what the
 * action does with the answers, not about the answers.
 */

/** Where `redirect()` was asked to send the browser, in call order. */
const redirects: string[] = []

vi.mock('next/navigation', () => ({
  // Next's redirect() works by throwing, and every action in this codebase is
  // written around that. Modelled exactly, or the code after a redirect would
  // run in tests and nowhere else.
  redirect: (target: string) => {
    redirects.push(target)
    throw new Error(`NEXT_REDIRECT:${target}`)
  }
}))

const requestPasswordReset = vi.fn()
const changePassword = vi.fn()

vi.mock('@/server/services/passwords', () => ({
  requestPasswordReset: (...args: unknown[]) => requestPasswordReset(...args),
  changePassword: (...args: unknown[]) => changePassword(...args)
}))

const ensureEmailSender = vi.fn()
const send = vi.fn(async () => 'SENT')

vi.mock('@/server/notifications/resend', () => ({
  ensureEmailSender: () => ensureEmailSender()
}))
vi.mock('@/server/notifications/sender', () => ({
  getSender: () => ({ send })
}))

const requireUser = vi.fn()
const signOut = vi.fn(async (_options?: { redirectTo?: string }) => undefined)

vi.mock('@/server/session', () => ({
  requireUser: () => requireUser()
}))
vi.mock('@/server/auth', () => ({
  signOut: (options?: { redirectTo?: string }) => signOut(options)
}))

const { requestPasswordResetAction } = await import('@/app/forgot-password/actions')
const { changePasswordAction } = await import('@/server/actions/passwords')
const { ServiceError } = await import('@/server/services/errors')

const SENT_TARGET = '/forgot-password?sent=1'
/** Must match RESPONSE_FLOOR_MS in the action. */
const FLOOR_MS = 1200

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.append(key, value)
  return data
}

/**
 * Run the action to completion, driving the timing floor's sleep with fake
 * timers so the suite does not actually wait 1.2 seconds per case. Returns
 * whatever the action returned, or the redirect target it threw for.
 */
async function runForgot(email: string): Promise<{ redirected: string | null; returned: unknown }> {
  const settled = requestPasswordResetAction(undefined, form({ email })).then(
    (returned) => ({ redirected: null, returned }),
    (error: Error) => {
      const match = /^NEXT_REDIRECT:(.*)$/.exec(error.message)
      if (!match) throw error
      return { redirected: match[1], returned: undefined }
    }
  )
  await vi.runAllTimersAsync()
  return settled
}

beforeEach(() => {
  redirects.length = 0
  requestPasswordReset.mockReset()
  changePassword.mockReset()
  ensureEmailSender.mockReset()
  send.mockReset()
  send.mockResolvedValue('SENT')
  requireUser.mockReset()
  signOut.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('requestPasswordResetAction', () => {
  it('sends every outcome to the same confirmation page', async () => {
    // A real, unthrottled user: a link comes back and is mailed.
    requestPasswordReset.mockResolvedValueOnce({
      resetUrl: 'https://precon.test/reset-password?token=abc',
      fullName: 'Chidi Okeke'
    })
    const real = await runForgot('chidi@sunrise.test')

    // Unknown address, and throttled address: the service reports both the
    // same way, and so must this.
    requestPasswordReset.mockResolvedValueOnce({ resetUrl: null, fullName: null })
    const unknown = await runForgot('nobody@nowhere.test')

    requestPasswordReset.mockResolvedValueOnce({ resetUrl: null, fullName: null })
    const throttled = await runForgot('chidi@sunrise.test')

    // The send blew up — a failure only a real recipient can produce, and
    // therefore the one that must be invisible.
    requestPasswordReset.mockResolvedValueOnce({
      resetUrl: 'https://precon.test/reset-password?token=abc',
      fullName: 'Chidi Okeke'
    })
    send.mockRejectedValueOnce(new Error('Resend is down'))
    const failed = await runForgot('chidi@sunrise.test')

    for (const outcome of [real, unknown, throttled, failed]) {
      expect(outcome.redirected).toBe(SENT_TARGET)
      expect(outcome.returned).toBeUndefined()
    }
    expect(new Set(redirects).size).toBe(1)
    expect(redirects).toHaveLength(4)
  })

  it('redirects the same way when the service itself throws', async () => {
    requestPasswordReset.mockRejectedValueOnce(new Error('database is on fire'))

    const outcome = await runForgot('chidi@sunrise.test')

    expect(outcome.redirected).toBe(SENT_TARGET)
  })

  it('redirects the same way when the mail sender is unconfigured', async () => {
    requestPasswordReset.mockResolvedValueOnce({
      resetUrl: 'https://precon.test/reset-password?token=abc',
      fullName: 'Chidi Okeke'
    })
    ensureEmailSender.mockImplementationOnce(() => {
      throw new Error('RESEND_API_KEY is not set')
    })

    const outcome = await runForgot('chidi@sunrise.test')

    expect(outcome.redirected).toBe(SENT_TARGET)
    expect(send).not.toHaveBeenCalled()
  })

  it('takes the same wall-clock time whatever happened', async () => {
    // The oracle this floor closes: the real path awaits an HTTPS round trip,
    // the unknown and throttled paths return after one or two indexed reads.
    // Identical wording, visibly different latency.
    async function elapsedFor(setup: () => void): Promise<number> {
      setup()
      let done = false
      const running = requestPasswordResetAction(undefined, form({ email: 'a@b.test' })).catch(
        () => {
          done = true
        }
      )

      await vi.advanceTimersByTimeAsync(FLOOR_MS - 1)
      expect(done).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await running
      expect(done).toBe(true)
      return FLOOR_MS
    }

    const unknown = await elapsedFor(() => {
      requestPasswordReset.mockResolvedValueOnce({ resetUrl: null, fullName: null })
    })
    const real = await elapsedFor(() => {
      requestPasswordReset.mockResolvedValueOnce({
        resetUrl: 'https://precon.test/reset-password?token=abc',
        fullName: 'Chidi Okeke'
      })
      // A slow send, well inside the budget.
      send.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve('SENT'), 400))
      )
    })

    expect(real).toBe(unknown)
  })

  it('rejects a malformed address without touching the service', async () => {
    const returned = await requestPasswordResetAction(undefined, form({ email: 'not-an-email' }))

    expect(returned).toBe('Enter a valid email address')
    expect(requestPasswordReset).not.toHaveBeenCalled()
    expect(redirects).toHaveLength(0)
  })
})

describe('changePasswordAction', () => {
  const actor = {
    userId: 'usr_session',
    orgId: 'org_1',
    role: 'AGENT' as const,
    buyerId: null,
    fullName: 'Chidi Okeke',
    email: 'chidi@sunrise.test'
  }

  beforeEach(() => {
    requireUser.mockResolvedValue(actor)
    changePassword.mockResolvedValue(undefined)
  })

  it('ignores a userId injected into the form and uses the session', async () => {
    await changePasswordAction(
      undefined,
      form({
        currentPassword: 'password123',
        password: 'newpassword456',
        confirmation: 'newpassword456',
        // Attacker-supplied. Nothing may read these.
        userId: 'usr_victim',
        email: 'victim@sunrise.test',
        id: 'usr_victim'
      })
    )

    expect(changePassword).toHaveBeenCalledTimes(1)
    expect(changePassword.mock.calls[0][0]).toBe('usr_session')
    expect(JSON.stringify(changePassword.mock.calls[0])).not.toContain('usr_victim')
    expect(JSON.stringify(changePassword.mock.calls[0])).not.toContain('victim@sunrise.test')
  })

  it('signs the user out once the password is changed', async () => {
    await changePasswordAction(
      undefined,
      form({
        currentPassword: 'password123',
        password: 'newpassword456',
        confirmation: 'newpassword456'
      })
    )

    expect(signOut).toHaveBeenCalledWith({ redirectTo: '/login?changed=1' })
  })

  it('authenticates before it reads the form at all', async () => {
    requireUser.mockRejectedValueOnce(new Error('NEXT_REDIRECT:/login'))

    await expect(
      changePasswordAction(undefined, form({ password: 'newpassword456' }))
    ).rejects.toThrow('NEXT_REDIRECT:/login')
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('returns the service message and does not sign out when the change fails', async () => {
    changePassword.mockRejectedValueOnce(
      new ServiceError('Your current password is incorrect.', 'VALIDATION')
    )

    const returned = await changePasswordAction(
      undefined,
      form({
        currentPassword: 'wrongpassword',
        password: 'newpassword456',
        confirmation: 'newpassword456'
      })
    )

    expect(returned).toBe('Your current password is incorrect.')
    expect(signOut).not.toHaveBeenCalled()
  })

  it('refuses a mismatched confirmation before calling the service', async () => {
    const returned = await changePasswordAction(
      undefined,
      form({
        currentPassword: 'password123',
        password: 'newpassword456',
        confirmation: 'newpassword457'
      })
    )

    expect(returned).toBe('The two passwords do not match.')
    expect(changePassword).not.toHaveBeenCalled()
  })
})
