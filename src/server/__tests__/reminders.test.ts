import { describe, expect, it } from 'vitest'
import { planReminders } from '@/server/notifications/reminders'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

const sale = (entries: Array<[string, Date, bigint, bigint]>, overrides = {}) => ({
  id: 'sale_1',
  orgId: 'org_1',
  currency: 'NGN',
  project: {
    name: 'Sunrise Heights',
    reminderDaysBefore: 7,
    overdueNoticeDaysAfter: 3,
    reminderChannels: ['EMAIL' as const],
    ...overrides
  },
  unit: { name: '305' },
  buyer: { fullName: 'Amina Yusuf', email: 'amina@buyer.test', phone: '+2348031234567', smsOptIn: true },
  scheduleEntries: entries.map(([id, dueDate, amountDueMinor, amountPaidMinor]) => ({
    id,
    dueDate,
    amountDueMinor,
    amountPaidMinor
  }))
})

describe('planReminders', () => {
  const asOf = utc(2026, 8, 9)

  it('schedules a due-soon notice exactly N days before the due date', () => {
    const jobs = planReminders([sale([['e1', utc(2026, 8, 16), 300n, 0n]])], asOf)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].templateKey).toBe('DUE_SOON')
    expect(jobs[0].daysUntilDue).toBe(7)
    expect(jobs[0].destination).toBe('amina@buyer.test')
  })

  // The windows are inclusive, not exact-day: a cron run that never happened
  // must not silently lose that day's reminders for good. NotificationLog's
  // unique index is what keeps the wider window from re-sending.
  it('schedules a due-soon notice anywhere inside the window', () => {
    // Offsets 6, 1 and 0 — every one of them missed by an equality test.
    for (const due of [utc(2026, 8, 15), utc(2026, 8, 10), utc(2026, 8, 9)]) {
      const jobs = planReminders([sale([['e1', due, 300n, 0n]])], asOf)
      expect(jobs, `due ${due.toISOString().slice(0, 10)} is inside the window`).toHaveLength(1)
      expect(jobs[0].templateKey).toBe('DUE_SOON')
    }
  })

  it('schedules nothing past the far edge of the due-soon window', () => {
    // Offset 8 against reminderDaysBefore 7 — one day too early to notify.
    expect(planReminders([sale([['e1', utc(2026, 8, 17), 300n, 0n]])], asOf)).toEqual([])
  })

  it('schedules nothing in the gap between due and the overdue threshold', () => {
    // Past due but not yet 3 days late: offset -1, then -2, the day before the
    // overdue notice becomes due. The gap between the two windows stays empty.
    expect(planReminders([sale([['e1', utc(2026, 8, 8), 300n, 0n]])], asOf)).toEqual([])
    expect(planReminders([sale([['e1', utc(2026, 8, 7), 300n, 0n]])], asOf)).toEqual([])
  })

  it('schedules an overdue notice exactly N days after the due date', () => {
    const jobs = planReminders([sale([['e1', utc(2026, 8, 6), 300n, 0n]])], asOf)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].templateKey).toBe('OVERDUE')
    expect(jobs[0].daysLate).toBe(3)
  })

  it('still schedules an overdue notice long past the threshold', () => {
    // 40 days late — an equality test stopped seeing this entry on day 4.
    const jobs = planReminders([sale([['e1', utc(2026, 6, 30), 300n, 0n]])], asOf)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].templateKey).toBe('OVERDUE')
    expect(jobs[0].daysLate).toBe(40)
  })

  it('plans the reminder a missed cron day should have sent', () => {
    // The sweep should have run on 2026-08-09 (offset 7, exactly day N) and
    // did not. The next day's run must still plan it, one day closer to due.
    const entry = sale([['e1', utc(2026, 8, 16), 300n, 0n]])
    expect(planReminders([entry], utc(2026, 8, 9))).toHaveLength(1)

    const nextDay = planReminders([entry], utc(2026, 8, 10))
    expect(nextDay).toHaveLength(1)
    expect(nextDay[0].templateKey).toBe('DUE_SOON')
    expect(nextDay[0].scheduleEntryId).toBe('e1')
    expect(nextDay[0].daysUntilDue).toBe(6)
  })

  it('respects a per-project reminder window', () => {
    const jobs = planReminders(
      [sale([['e1', utc(2026, 8, 19), 300n, 0n]], { reminderDaysBefore: 10 })],
      asOf
    )
    expect(jobs).toHaveLength(1)
    expect(jobs[0].daysUntilDue).toBe(10)
  })

  it('never reminds about a fully paid installment', () => {
    expect(planReminders([sale([['e1', utc(2026, 8, 16), 300n, 300n]])], asOf)).toEqual([])
    expect(planReminders([sale([['e1', utc(2026, 8, 6), 300n, 300n]])], asOf)).toEqual([])
  })

  it('still reminds about a partially paid installment, for the balance', () => {
    const jobs = planReminders([sale([['e1', utc(2026, 8, 16), 300n, 100n]])], asOf)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].amountMinor).toBe(200n)
  })

  it('emits one job per configured channel', () => {
    const jobs = planReminders(
      [sale([['e1', utc(2026, 8, 16), 300n, 0n]], { reminderChannels: ['EMAIL', 'SMS'] })],
      asOf
    )
    expect(jobs.map((j) => j.channel).sort()).toEqual(['EMAIL', 'SMS'])
    expect(jobs.find((j) => j.channel === 'SMS')?.destination).toBe('+2348031234567')
  })

  it('skips the SMS channel when the buyer has opted out', () => {
    const base = sale([['e1', utc(2026, 8, 16), 300n, 0n]], { reminderChannels: ['EMAIL', 'SMS'] })
    const jobs = planReminders([{ ...base, buyer: { ...base.buyer, smsOptIn: false } }], asOf)
    expect(jobs.map((j) => j.channel)).toEqual(['EMAIL'])
  })

  it('handles several entries across several sales', () => {
    const jobs = planReminders(
      [
        sale([['e1', utc(2026, 8, 16), 300n, 0n], ['e2', utc(2026, 9, 16), 300n, 0n]]),
        { ...sale([['e3', utc(2026, 8, 6), 300n, 0n]]), id: 'sale_2' }
      ],
      asOf
    )
    expect(jobs.map((j) => j.scheduleEntryId).sort()).toEqual(['e1', 'e3'])
  })
})
