import { Prisma, type ReminderChannel } from '@prisma/client'
import { prisma } from '@/server/db'
import { getSender } from '@/server/notifications/sender'
import { renderTemplate, type TemplateData, type TemplateKey } from '@/server/notifications/templates'

export type DispatchOutcome = 'SENT' | 'SKIPPED' | 'FAILED'

export async function dispatchReminder(args: {
  orgId: string
  scheduleEntryId: string
  channel: ReminderChannel
  templateKey: TemplateKey
  destination: string
  data: TemplateData
}): Promise<DispatchOutcome> {
  // The unique index does the work: if this reminder was already logged, the
  // create throws P2002 and we skip. A retried cron run cannot double-send.
  try {
    await prisma.notificationLog.create({
      data: {
        orgId: args.orgId,
        scheduleEntryId: args.scheduleEntryId,
        channel: args.channel,
        templateKey: args.templateKey,
        destination: args.destination,
        status: 'PENDING'
      }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return 'SKIPPED'
    }
    throw error
  }

  const message = renderTemplate(args.templateKey, args.data)

  try {
    const { providerMessageId } = await getSender(args.channel).send({
      destination: args.destination,
      ...message
    })

    await prisma.notificationLog.update({
      where: {
        scheduleEntryId_templateKey_channel: {
          scheduleEntryId: args.scheduleEntryId,
          templateKey: args.templateKey,
          channel: args.channel
        }
      },
      data: { status: 'SENT', sentAt: new Date(), providerMessageId: providerMessageId ?? null }
    })

    return 'SENT'
  } catch (error) {
    await prisma.notificationLog.update({
      where: {
        scheduleEntryId_templateKey_channel: {
          scheduleEntryId: args.scheduleEntryId,
          templateKey: args.templateKey,
          channel: args.channel
        }
      },
      data: { status: 'FAILED', error: error instanceof Error ? error.message : String(error) }
    })

    return 'FAILED'
  }
}
