import { Resend } from 'resend'
import { registerSender } from '@/server/notifications/sender'

let registered = false

export function ensureEmailSender(): void {
  if (registered) return

  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM
  if (!apiKey || !from) {
    throw new Error('RESEND_API_KEY and EMAIL_FROM must be set to send email')
  }

  const resend = new Resend(apiKey)

  registerSender({
    channel: 'EMAIL',
    async send({ destination, subject, text, html }) {
      const result = await resend.emails.send({ from, to: destination, subject, text, html })
      if (result.error) throw new Error(result.error.message)
      return { providerMessageId: result.data?.id }
    }
  })

  registered = true
}
