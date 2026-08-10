import type { ReminderChannel } from '@prisma/client'

export interface OutboundMessage {
  destination: string
  subject: string
  text: string
  html: string
}

export interface NotificationSender {
  channel: ReminderChannel
  send(message: OutboundMessage): Promise<{ providerMessageId?: string }>
}

const registry = new Map<ReminderChannel, NotificationSender>()

export function registerSender(sender: NotificationSender): void {
  registry.set(sender.channel, sender)
}

export class ChannelUnavailableError extends Error {
  constructor(channel: ReminderChannel) {
    super(`No sender is registered for the ${channel} channel`)
    this.name = 'ChannelUnavailableError'
  }
}

export function getSender(channel: ReminderChannel): NotificationSender {
  const sender = registry.get(channel)
  if (!sender) throw new ChannelUnavailableError(channel)
  return sender
}

/**
 * Lets a caller check whether a channel already has a sender registered
 * before deciding whether to register its own (e.g. a real one guarded by
 * env vars). Used by `ensureEmailSender` so a fake sender registered
 * directly through `registerSender` — as verification scripts and tests
 * do — makes the real Resend setup a no-op instead of throwing on missing
 * credentials.
 */
export function hasSender(channel: ReminderChannel): boolean {
  return registry.has(channel)
}

/**
 * Adding SMS later is exactly this and nothing more:
 *
 *   registerSender({
 *     channel: 'SMS',
 *     async send({ destination, text }) {
 *       const res = await africasTalking.send({ to: destination, message: text })
 *       return { providerMessageId: res.id }
 *     }
 *   })
 *
 * The enum value, the Project.reminderChannels array, Buyer.phone in E.164,
 * Buyer.smsOptIn and NotificationLog.destination all already exist, so no
 * migration is involved.
 */
