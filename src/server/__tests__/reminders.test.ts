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

  it('schedules nothing on other days before the due date', () => {
    expect(planReminders([sale([['e1', utc(2026, 8, 15), 300n, 0n]])], asOf)).toEqual([])
    expect(planReminders([sale([['e1', utc(2026, 8, 17), 300n, 0n]])], asOf)).toEqual([])
  })

  it('schedules an overdue notice exactly N days after the due date', () => {
    const jobs = planReminders([sale([['e1', utc(2026, 8, 6), 300n, 0n]])], asOf)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].templateKey).toBe('OVERDUE')
    expect(jobs[0].daysLate).toBe(3)
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
