import { describe, expect, it } from 'vitest'
import { renderPasswordResetEmail, renderTemplate } from '@/server/notifications/templates'

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

  it('entity-encodes a hostile buyer name in the html body but leaves the text body untouched', () => {
    const hostileName = '<img src=x onerror=alert(1)>'
    const out = renderTemplate('DUE_SOON', { ...base, buyerName: hostileName })

    expect(out.html).not.toContain(hostileName)
    expect(out.html).toContain('&lt;img src=x onerror=alert(1)&gt;')

    expect(out.text).toContain(hostileName)
  })

  it('entity-encodes hostile org, project, and unit names in the html body', () => {
    const out = renderTemplate('DUE_SOON', {
      ...base,
      orgName: '<b>Sunrise</b>',
      projectName: '<i>Heights</i>',
      unitName: '"305"'
    })

    expect(out.html).not.toContain('<b>Sunrise</b>')
    expect(out.html).toContain('&lt;b&gt;Sunrise&lt;/b&gt;')
    expect(out.html).not.toContain('<i>Heights</i>')
    expect(out.html).toContain('&lt;i&gt;Heights&lt;/i&gt;')
    expect(out.html).toContain('&quot;305&quot;')
  })

  it('quote-escapes a hostile documentUrl before it lands in the href attribute', () => {
    const hostileUrl = 'https://example.com/x" onmouseover="alert(1)'
    const out = renderTemplate('DUE_SOON', { ...base, documentUrl: hostileUrl })

    expect(out.html).not.toContain(`href="${hostileUrl}"`)
    expect(out.html).toContain('href="https://example.com/x&quot; onmouseover=&quot;alert(1)"')
  })
})

describe('renderPasswordResetEmail', () => {
  const base = {
    fullName: 'Chidi Okeke',
    resetUrl: 'https://precon.test/reset-password?token=abc123',
    expiresInMinutes: 60
  }

  it('puts the full link in the plain-text body, not only in the HTML', () => {
    // The plain-text part is first-class here: a buyer on a phone whose mail
    // client does not render the HTML part must still be able to reach the
    // link, by tapping it or by copying it out by hand.
    const out = renderPasswordResetEmail(base)
    expect(out.text).toContain(base.resetUrl)
    expect(out.text).toContain('Chidi Okeke')
  })

  it('says the link expires in 60 minutes, in both bodies', () => {
    const out = renderPasswordResetEmail(base)
    expect(out.text).toContain('60 minutes')
    expect(out.html).toContain('60 minutes')
  })

  it('tells an unexpecting recipient to do nothing', () => {
    const out = renderPasswordResetEmail(base)
    expect(out.text).toContain('you can ignore this email')
    expect(out.text).toContain('your password has not changed')
  })

  it('escapes a hostile name before it reaches the HTML body', () => {
    const out = renderPasswordResetEmail({ ...base, fullName: '<b>Chidi</b>' })
    expect(out.html).not.toContain('<b>Chidi</b>')
    expect(out.html).toContain('&lt;b&gt;Chidi&lt;/b&gt;')
  })

  it('quote-escapes the URL before it lands in the href attribute', () => {
    const hostile = 'https://precon.test/reset-password?token=x" onmouseover="alert(1)'
    const out = renderPasswordResetEmail({ ...base, resetUrl: hostile })
    expect(out.html).not.toContain(`href="${hostile}"`)
    expect(out.html).toContain('&quot; onmouseover=&quot;alert(1)')
  })

  it('greets without a name rather than "Hello ," when the name is blank', () => {
    const out = renderPasswordResetEmail({ ...base, fullName: '  ' })
    expect(out.text.startsWith('Hello,')).toBe(true)
  })
})
