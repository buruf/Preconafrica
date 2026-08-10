import { Prisma, type ReminderChannel } from '@prisma/client'
import { prisma } from '@/server/db'
import { getSender } from '@/server/notifications/sender'
import { renderTemplate, type TemplateData, type TemplateKey } from '@/server/notifications/templates'
import { constraintTargetIncludes } from '@/server/services/units'

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
  // Only a P2002 on the (scheduleEntryId, templateKey, channel) idempotency
  // index means "already handled" — checking the constraint target (not just
  // the P2002 code) keeps this from silently misreporting some future,
  // unrelated unique violation on this table as "already sent".
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
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      constraintTargetIncludes(error.meta?.target, 'scheduleEntryId')
    ) {
      return 'SKIPPED'
    }
    throw error
  }

  const message = renderTemplate(args.templateKey, args.data)
  const where = {
    scheduleEntryId_templateKey_channel: {
      scheduleEntryId: args.scheduleEntryId,
      templateKey: args.templateKey,
      channel: args.channel
    }
  } as const

  // The send and the SENT bookkeeping update are two separate failure modes
  // that must not be conflated. If the send itself throws, nothing was
  // delivered and FAILED is the plain truth — a human can safely delete this
  // row later to retry. But if the send succeeds and only the follow-up
  // update throws, the message *was* delivered; marking that FAILED with an
  // ordinary message would invite an operator to delete the row and resend,
  // producing a real duplicate email to the buyer. That case gets its own
  // branch and a message that says so explicitly.
  let providerMessageId: string | undefined
  try {
    ;({ providerMessageId } = await getSender(args.channel).send({
      destination: args.destination,
      ...message
    }))
  } catch (error) {
    try {
      await prisma.notificationLog.update({
        where,
        data: { status: 'FAILED', error: error instanceof Error ? error.message : String(error) }
      })
    } catch {
      // Double fault (e.g. the row was deleted mid-flight): the bookkeeping
      // write is lost, but dispatchReminder must still always resolve rather
      // than let this escape and break the cron sweep.
    }
    return 'FAILED'
  }

  try {
    await prisma.notificationLog.update({
      where,
      data: { status: 'SENT', sentAt: new Date(), providerMessageId: providerMessageId ?? null }
    })
    return 'SENT'
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error)
    try {
      await prisma.notificationLog.update({
        where,
        data: {
          status: 'FAILED',
          error: `SENT_UNCONFIRMED: message was delivered but recording it failed — do not delete this row to re-send. ${original}`
        }
      })
    } catch {
      // Same double-fault reasoning as above: losing this bookkeeping write
      // is acceptable, throwing out of dispatchReminder is not.
    }
    return 'FAILED'
  }
}
