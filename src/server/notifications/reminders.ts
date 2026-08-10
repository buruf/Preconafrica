import type { ReminderChannel } from '@prisma/client'
import { prisma } from '@/server/db'
import { differenceInDaysUtc } from '@/domain/dates'
import { outstandingMinor } from '@/domain/status'
import { dispatchReminder } from '@/server/notifications/dispatch'
import { ensureEmailSender } from '@/server/notifications/resend'
import type { TemplateKey } from '@/server/notifications/templates'

export interface ReminderJob {
  orgId: string
  saleId: string
  scheduleEntryId: string
  channel: ReminderChannel
  templateKey: TemplateKey
  destination: string
  buyerName: string
  projectName: string
  unitName: string
  currency: string
  amountMinor: bigint
  dueDate: Date
  daysUntilDue: number
  daysLate: number
}

interface ReminderSale {
  id: string
  orgId: string
  currency: string
  project: {
    name: string
    reminderDaysBefore: number
    overdueNoticeDaysAfter: number
    reminderChannels: ReminderChannel[]
  }
  unit: { name: string }
  buyer: { fullName: string; email: string; phone: string; smsOptIn: boolean }
  scheduleEntries: Array<{
    id: string
    dueDate: Date
    amountDueMinor: bigint
    amountPaidMinor: bigint
  }>
}

/** Pure: decides what should be sent today. No I/O, no clock. */
export function planReminders(sales: ReminderSale[], asOf: Date): ReminderJob[] {
  const jobs: ReminderJob[] = []

  for (const sale of sales) {
    for (const entry of sale.scheduleEntries) {
      const outstanding = outstandingMinor(entry)
      if (outstanding === 0n) continue

      const offset = differenceInDaysUtc(entry.dueDate, asOf)

      let templateKey: TemplateKey | null = null
      if (offset === sale.project.reminderDaysBefore) templateKey = 'DUE_SOON'
      else if (-offset === sale.project.overdueNoticeDaysAfter) templateKey = 'OVERDUE'
      if (!templateKey) continue

      for (const channel of sale.project.reminderChannels) {
        if (channel === 'SMS' && !sale.buyer.smsOptIn) continue

        jobs.push({
          orgId: sale.orgId,
          saleId: sale.id,
          scheduleEntryId: entry.id,
          channel,
          templateKey,
          destination: channel === 'EMAIL' ? sale.buyer.email : sale.buyer.phone,
          buyerName: sale.buyer.fullName,
          projectName: sale.project.name,
          unitName: sale.unit.name,
          currency: sale.currency,
          amountMinor: outstanding,
          dueDate: entry.dueDate,
          daysUntilDue: offset > 0 ? offset : 0,
          daysLate: offset < 0 ? -offset : 0
        })
      }
    }
  }

  return jobs
}

export async function runReminderSweep(asOf: Date) {
  ensureEmailSender()

  const sales = await prisma.sale.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      orgId: true,
      currency: true,
      project: {
        select: {
          name: true,
          reminderDaysBefore: true,
          overdueNoticeDaysAfter: true,
          reminderChannels: true
        }
      },
      unit: { select: { name: true } },
      buyer: { select: { fullName: true, email: true, phone: true, smsOptIn: true } },
      scheduleEntries: {
        select: { id: true, dueDate: true, amountDueMinor: true, amountPaidMinor: true }
      }
    }
  })

  const jobs = planReminders(sales, asOf)
  const baseUrl = process.env.NEXTAUTH_URL ?? ''
  const tally = { sent: 0, skipped: 0, failed: 0 }

  // Org names are looked up once for every distinct org touched by today's
  // jobs, rather than once per job inside the loop below (the brief's
  // original sweep called `findUniqueOrThrow` per job — an N+1 against a
  // table with only a handful of rows, but pointless repeated round trips).
  const orgIds = [...new Set(jobs.map((job) => job.orgId))]
  const orgs = await prisma.organization.findMany({
    where: { id: { in: orgIds } },
    select: { id: true, name: true }
  })
  const orgNameById = new Map(orgs.map((org) => [org.id, org.name]))

  for (const job of jobs) {
    // SMS has no registered sender yet; skip rather than fail the sweep.
    if (job.channel === 'SMS') {
      tally.skipped += 1
      continue
    }

    const orgName = orgNameById.get(job.orgId)
    if (orgName === undefined) {
      // Should be unreachable: every job's orgId came from a sale that was
      // just queried, and every sale has a required org. Fail loudly rather
      // than send an email with a blank org name.
      throw new Error(`No organization found for orgId ${job.orgId}`)
    }

    const outcome = await dispatchReminder({
      orgId: job.orgId,
      scheduleEntryId: job.scheduleEntryId,
      channel: job.channel,
      templateKey: job.templateKey,
      destination: job.destination,
      data: {
        buyerName: job.buyerName,
        orgName,
        projectName: job.projectName,
        unitName: job.unitName,
        currency: job.currency,
        amountMinor: job.amountMinor,
        dueDate: job.dueDate,
        daysUntilDue: job.daysUntilDue,
        daysLate: job.daysLate,
        documentUrl: `${baseUrl}/dashboard`
      }
    })

    if (outcome === 'SENT') tally.sent += 1
    else if (outcome === 'SKIPPED') tally.skipped += 1
    else tally.failed += 1
  }

  return tally
}
