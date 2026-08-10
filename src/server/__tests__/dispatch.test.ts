import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * dispatchReminder's whole job is deciding what a failure *means*, and every
 * one of those decisions is a database or provider outcome — so the seam under
 * test is the branch table, not the arithmetic. `@/server/db` is mocked
 * (nothing here talks to Postgres) and the sender registry, which exists
 * precisely so a fake sender can be swapped in, supplies the provider.
 *
 * The distinction being pinned down: a send that never happened is an ordinary
 * FAILED that an operator may safely retry by deleting the log row, while a
 * send that DID happen and only failed to be recorded must never be retried —
 * doing so mails the buyer twice. Conflating the two is a real-world mistake
 * with a real-world cost, which is why it gets its own branch and its own
 * message prefix.
 */
vi.mock('@/server/db', () => ({
  prisma: {
    notificationLog: {
      create: vi.fn(),
      update: vi.fn()
    }
  }
}))

const { prisma } = await import('@/server/db')
const { dispatchReminder } = await import('@/server/notifications/dispatch')
const { registerSender } = await import('@/server/notifications/sender')

const create = prisma.notificationLog.create as unknown as ReturnType<typeof vi.fn>
const update = prisma.notificationLog.update as unknown as ReturnType<typeof vi.fn>

/** A P2002 with a chosen constraint target, the way Prisma reports one. */
function uniqueViolation(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target }
  })
}

const IDEMPOTENCY_TARGET = ['scheduleEntryId', 'templateKey', 'channel']

const send = vi.fn<(message: unknown) => Promise<{ providerMessageId?: string }>>()

const args = {
  orgId: 'org_1',
  scheduleEntryId: 'entry_1',
  channel: 'EMAIL' as const,
  templateKey: 'DUE_SOON' as const,
  destination: 'amina@buyer.test',
  data: {
    buyerName: 'Amina Yusuf',
    orgName: 'Sunrise Developments',
    projectName: 'Sunrise Heights',
    unitName: '305',
    currency: 'NGN',
    amountMinor: 30_000_000n,
    dueDate: new Date(Date.UTC(2026, 7, 16)),
    daysUntilDue: 7,
    daysLate: 0,
    documentUrl: 'https://example.com/dashboard'
  }
}

/** The `data` the Nth notificationLog.update call was asked to write. */
function updateData(callIndex: number): { status: string; error?: string } {
  return update.mock.calls[callIndex][0].data
}

describe('dispatchReminder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    send.mockReset()
    send.mockResolvedValue({ providerMessageId: 'prov_1' })
    registerSender({ channel: 'EMAIL', send })
  })

  it('sends and records the provider id when everything works', async () => {
    create.mockResolvedValue({})
    update.mockResolvedValue({})

    await expect(dispatchReminder(args)).resolves.toBe('SENT')
    expect(send).toHaveBeenCalledTimes(1)
    expect(updateData(0).status).toBe('SENT')
    expect(update.mock.calls[0][0].data.providerMessageId).toBe('prov_1')
  })

  it('skips without sending when the idempotency constraint already holds a row', async () => {
    create.mockRejectedValue(uniqueViolation(IDEMPOTENCY_TARGET))

    await expect(dispatchReminder(args)).resolves.toBe('SKIPPED')
    // The point of the whole design: a retried cron run cannot mail twice.
    expect(send).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('rethrows a P2002 on some other constraint instead of calling it "already sent"', async () => {
    const unrelated = uniqueViolation(['destination'])
    create.mockRejectedValue(unrelated)

    await expect(dispatchReminder(args)).rejects.toBe(unrelated)
    expect(send).not.toHaveBeenCalled()
  })

  it('records FAILED with the provider error when the send throws', async () => {
    create.mockResolvedValue({})
    update.mockResolvedValue({})
    send.mockRejectedValue(new Error('provider refused the message'))

    await expect(dispatchReminder(args)).resolves.toBe('FAILED')
    expect(updateData(0).status).toBe('FAILED')
    expect(updateData(0).error).toBe('provider refused the message')
    // Nothing was delivered, so this row is safe to delete and retry — which
    // is exactly why it must NOT carry the SENT_UNCONFIRMED warning.
    expect(updateData(0).error).not.toContain('SENT_UNCONFIRMED')
  })

  it('marks a delivered-but-unrecorded send SENT_UNCONFIRMED, not plain FAILED', async () => {
    create.mockResolvedValue({})
    update
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({})

    await expect(dispatchReminder(args)).resolves.toBe('FAILED')
    expect(send).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(2)
    expect(updateData(1).status).toBe('FAILED')
    expect(updateData(1).error).toMatch(/^SENT_UNCONFIRMED: /)
    // The operator has to be told not to retry, and why.
    expect(updateData(1).error).toContain('do not delete this row to re-send')
    // And the underlying cause is not thrown away.
    expect(updateData(1).error).toContain('connection reset')
  })

  it('still resolves FAILED when the bookkeeping write itself also fails', async () => {
    create.mockResolvedValue({})
    update.mockRejectedValue(new Error('database is gone'))

    // A double fault must not escape: dispatchReminder is called in a loop, and
    // throwing here used to take every remaining job in the sweep with it.
    await expect(dispatchReminder(args)).resolves.toBe('FAILED')
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('resolves FAILED on a double fault after a failed send too', async () => {
    create.mockResolvedValue({})
    send.mockRejectedValue(new Error('provider refused the message'))
    update.mockRejectedValue(new Error('database is gone'))

    await expect(dispatchReminder(args)).resolves.toBe('FAILED')
    expect(update).toHaveBeenCalledTimes(1)
  })
})
