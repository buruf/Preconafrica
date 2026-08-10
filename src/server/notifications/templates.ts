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

export function renderTemplate(key: TemplateKey, data: TemplateData) {
  const amount = formatMinor(data.amountMinor, data.currency)
  const due = isoDate(data.dueDate)

  const subject =
    key === 'DUE_SOON'
      ? `Payment due in ${plural(data.daysUntilDue, 'day')} — ${data.projectName} unit ${data.unitName}`
      : `Overdue payment — ${data.projectName} unit ${data.unitName}`

  const lead =
    key === 'DUE_SOON'
      ? `Your next installment of ${amount} for unit ${data.unitName} is due on ${due}, in ${plural(data.daysUntilDue, 'day')}.`
      : `Your installment of ${amount} for unit ${data.unitName} was due on ${due} and is now ${plural(data.daysLate, 'day')} late.`

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
    `View or download the invoice: ${data.documentUrl}`,
    '',
    data.orgName
  ].join('\n')

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a;line-height:1.5">
<p>Hello ${data.buyerName},</p>
<p>${lead}</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px">
<tr><td style="color:#64748b">Project</td><td>${data.projectName}</td></tr>
<tr><td style="color:#64748b">Unit</td><td>${data.unitName}</td></tr>
<tr><td style="color:#64748b">Amount</td><td><strong>${amount}</strong></td></tr>
<tr><td style="color:#64748b">Due date</td><td>${due}</td></tr>
</table>
<p><a href="${data.documentUrl}">View or download the invoice</a></p>
<p style="color:#64748b">${data.orgName}</p>
</body></html>`

  return { subject, text, html }
}
