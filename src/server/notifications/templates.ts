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
