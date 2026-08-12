import { formatMinor } from '@/domain/currency'

export type TemplateKey = 'DUE_SOON' | 'OVERDUE'

export interface TemplateData {
  buyerName: string
  orgName: string
  projectName: string
  unitName: string
  currency: string
  amountMinor: bigint
  dueDate: Date
  daysUntilDue: number
  daysLate: number
  documentUrl: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/**
 * `buyerName`/`orgName`/`projectName`/`unitName` are free-form user input
 * (`Buyer.fullName` in particular has no character restriction beyond
 * length) that gets interpolated into an HTML email. Without escaping, a
 * name containing markup would be injected verbatim into what the
 * recipient's mail client renders — mail clients strip `<script>`, but not
 * arbitrary content injection (e.g. forged "pay to this account instead"
 * text made to look like it came from the developer). The plain-text body
 * is not run through this — it is not rendered as markup, so escaping there
 * would just corrupt the text a buyer reads.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface PasswordResetEmailData {
  fullName: string
  /** Absolute, and carrying the raw token — it is clicked from a mail client. */
  resetUrl: string
  expiresInMinutes: number
}

/**
 * The reset email. Plain text is not a fallback here, it is a first-class
 * body: this app's buyers and agents read mail on phones over connections
 * where the HTML part does not always render, and a reset link that only works
 * in a rendered HTML part is a reset link that sometimes does not work at all.
 * Both parts carry the full URL as visible text for the same reason — so it
 * can be copied by hand when tapping the link fails.
 *
 * Every interpolated value is escaped in the HTML part, `resetUrl` included.
 * The URL is app-generated rather than user input today, but it is the one
 * value that lands inside an `href` attribute, and an unescaped quote there is
 * an attribute-injection hole waiting for the day the base URL becomes
 * configurable per organisation.
 */
export function renderPasswordResetEmail(data: PasswordResetEmailData) {
  const subject = 'Reset your password'

  const greeting = data.fullName.trim() ? `Hello ${data.fullName.trim()},` : 'Hello,'
  const expiry = `This link expires in ${plural(data.expiresInMinutes, 'minute')} and can be used once.`
  // Worded as the reassurance it is: the person reading this may not be the
  // person who asked for it, and the only safe instruction for them is
  // "do nothing" — never "click here to cancel", which is just another link.
  const ignore =
    'If you did not ask to reset your password, you can ignore this email — your password has not changed.'

  const text = [
    greeting,
    '',
    'Use the link below to choose a new password:',
    '',
    data.resetUrl,
    '',
    expiry,
    '',
    ignore
  ].join('\n')

  const resetUrlHtml = escapeHtml(data.resetUrl)

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a;line-height:1.5">
<p>${escapeHtml(greeting)}</p>
<p>Use the link below to choose a new password:</p>
<p><a href="${resetUrlHtml}">${resetUrlHtml}</a></p>
<p>${escapeHtml(expiry)}</p>
<p style="color:#64748b">${escapeHtml(ignore)}</p>
</body></html>`

  return { subject, text, html }
}

export function renderTemplate(key: TemplateKey, data: TemplateData) {
  const amount = formatMinor(data.amountMinor, data.currency)
  const due = isoDate(data.dueDate)

  const subject =
    key === 'DUE_SOON'
      ? `Payment due in ${plural(data.daysUntilDue, 'day')} — ${data.projectName} unit ${data.unitName}`
      : `Overdue payment — ${data.projectName} unit ${data.unitName}`

  // "Payment", not "installment". The sweep reminds on every unsettled schedule
  // entry, and the deposit is now one of them — calling a deposit an
  // installment is wrong on precisely the notice a buyer is most likely to
  // query. Neutral wording is right for both and costs the monthly notices
  // nothing. One string, so the text and HTML bodies cannot say different
  // things (`leadHtml` below differs only in escaping the unit name).
  const lead =
    key === 'DUE_SOON'
      ? `Your next payment of ${amount} for unit ${data.unitName} is due on ${due}, in ${plural(data.daysUntilDue, 'day')}.`
      : `Your payment of ${amount} for unit ${data.unitName} was due on ${due} and is now ${plural(data.daysLate, 'day')} late.`

  const text = [
    `Hello ${data.buyerName},`,
    '',
    lead,
    '',
    `Project: ${data.projectName}`,
    `Unit: ${data.unitName}`,
    `Amount: ${amount}`,
    `Due date: ${due}`,
    '',
    // `documentUrl` is the buyer's dashboard, not a PDF: the link text says
    // what it actually opens rather than promising a document it never had.
    `View your payment schedule: ${data.documentUrl}`,
    '',
    data.orgName
  ].join('\n')

  const buyerNameHtml = escapeHtml(data.buyerName)
  const orgNameHtml = escapeHtml(data.orgName)
  const projectNameHtml = escapeHtml(data.projectName)
  const unitNameHtml = escapeHtml(data.unitName)
  const documentUrlHtml = escapeHtml(data.documentUrl)

  const leadHtml =
    key === 'DUE_SOON'
      ? `Your next payment of ${amount} for unit ${unitNameHtml} is due on ${due}, in ${plural(data.daysUntilDue, 'day')}.`
      : `Your payment of ${amount} for unit ${unitNameHtml} was due on ${due} and is now ${plural(data.daysLate, 'day')} late.`

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a;line-height:1.5">
<p>Hello ${buyerNameHtml},</p>
<p>${leadHtml}</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px">
<tr><td style="color:#64748b">Project</td><td>${projectNameHtml}</td></tr>
<tr><td style="color:#64748b">Unit</td><td>${unitNameHtml}</td></tr>
<tr><td style="color:#64748b">Amount</td><td><strong>${amount}</strong></td></tr>
<tr><td style="color:#64748b">Due date</td><td>${due}</td></tr>
</table>
<p><a href="${documentUrlHtml}">View your payment schedule</a></p>
<p style="color:#64748b">${orgNameHtml}</p>
</body></html>`

  return { subject, text, html }
}
