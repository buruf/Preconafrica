import { describe, expect, it } from 'vitest'
import { renderTemplate } from '@/server/notifications/templates'

const base = {
  buyerName: 'Amina Yusuf',
  orgName: 'Sunrise Developments',
  projectName: 'Sunrise Heights',
  unitName: '305',
  currency: 'NGN',
  amountMinor: 166_666_666n,
  dueDate: new Date(Date.UTC(2026, 7, 20)),
  daysUntilDue: 7,
  daysLate: 0,
  documentUrl: 'https://example.com/api/documents/doc_1'
}

describe('renderTemplate', () => {
  it('renders a due-soon notice naming the amount and date', () => {
    const out = renderTemplate('DUE_SOON', base)
    expect(out.subject).toContain('Sunrise Heights')
    expect(out.text).toContain('Amina Yusuf')
    expect(out.text).toContain('2026-08-20')
    expect(out.text).toContain('1,666,666.66')
    expect(out.text).toContain('7 days')
  })

  it('renders an overdue notice naming the lateness', () => {
    const out = renderTemplate('OVERDUE', { ...base, daysLate: 12, daysUntilDue: 0 })
    expect(out.subject.toLowerCase()).toContain('overdue')
    expect(out.text).toContain('12 days')
  })

  it('uses the singular for a single day', () => {
    expect(renderTemplate('DUE_SOON', { ...base, daysUntilDue: 1 }).text).toContain('1 day')
    expect(renderTemplate('DUE_SOON', { ...base, daysUntilDue: 1 }).text).not.toContain('1 days')
  })

  it('formats amounts in the project currency, not USD', () => {
    const kes = renderTemplate('DUE_SOON', { ...base, currency: 'KES', amountMinor: 25_555_600n })
    expect(kes.text).toContain('255,556')
    expect(kes.text).not.toContain('$')
  })

  it('includes the document link in the html body', () => {
    expect(renderTemplate('DUE_SOON', base).html).toContain(base.documentUrl)
  })

  it('produces a plain-text body for low-bandwidth clients', () => {
    expect(renderTemplate('DUE_SOON', base).text).not.toContain('<')
  })
})
