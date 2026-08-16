import { describe, expect, it } from 'vitest'
import {
  describeAuditEntry,
  enumValue,
  image,
  money,
  number,
  text,
  type AuditEntryView
} from '@/domain/audit'

/**
 * `Intl.NumberFormat` separates a currency code from its figure with a
 * non-breaking space (U+00A0), so `formatMinor` emits NGN 145,000,000.00.
 * The expected strings below are written with ordinary spaces so they stay
 * readable in this file; that is the only difference between what is asserted
 * and what actually renders.
 */
function plain(value: string): string {
  return value.replace(new RegExp(String.fromCharCode(160), 'g'), ' ')
}

/**
 * Every action, as the sentence an admin actually reads.
 *
 * The requirement is that a non-technical property developer can read a row
 * without being taught anything — so these assertions are the literal strings,
 * not a shape. If a sentence gets worse, this file says so in the diff.
 *
 * The renaming case at the bottom is the load-bearing one. It is why entries
 * snapshot `entityLabel`, `actorName`, `actorRole` and `context.unitName`
 * instead of joining: the log describes the past, and the past does not change
 * when somebody renames a unit today.
 */

function entry(overrides: Partial<AuditEntryView>): AuditEntryView {
  return {
    id: 'audit_1',
    actorName: 'Tunde Bakare',
    actorRole: 'ADMIN',
    action: 'payment.voided',
    entityType: 'Payment',
    entityId: 'payment_1',
    entityLabel: '4C',
    changes: [],
    context: {},
    createdAt: new Date('2026-08-14T09:12:00.000Z'),
    ...overrides
  }
}

describe('the sentence each action renders as', () => {
  it('voids a payment, with the figure, the unit and the reason', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'payment.voided',
        context: {
          saleId: 'sale_1',
          unitName: '4C',
          currency: 'KES',
          amountMinor: '18333333',
          reason: 'duplicate entry'
        }
      })
    )

    // The owner's own example, verbatim bar the timestamp the page appends.
    expect(plain(sentence)).toBe(
      'Tunde Bakare voided a KES 183,333.33 payment on unit 4C — “duplicate entry”'
    )
  })

  it('records a payment, naming the installment it settled', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'payment.recorded',
        context: {
          saleId: 'sale_1',
          unitName: '4C',
          currency: 'NGN',
          amountMinor: '2500000000',
          entrySequence: 2
        }
      })
    )

    expect(plain(sentence)).toBe(
      'Tunde Bakare recorded a NGN 25,000,000.00 payment on unit 4C — installment 2'
    )
  })

  it('calls sequence zero the deposit, as the schedule does everywhere else', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'payment.recorded',
        context: { unitName: '4C', currency: 'NGN', amountMinor: '500000000', entrySequence: 0 }
      })
    )

    expect(plain(sentence)).toContain('— the deposit')
  })

  it('creates a sale, naming the buyer, the plan and the price', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'sale.created',
        entityType: 'Sale',
        entityId: 'sale_1',
        context: {
          unitName: '4C',
          buyerName: 'Amina Yusuf',
          planLabel: '12-month installment plan',
          currency: 'NGN',
          amountMinor: '14500000000'
        }
      })
    )

    expect(plain(sentence)).toBe(
      'Tunde Bakare sold unit 4C to Amina Yusuf on a 12-month installment plan at NGN 145,000,000.00'
    )
  })

  it('moves a sale between statuses', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'sale.status_changed',
        entityType: 'Sale',
        entityId: 'sale_1',
        changes: [{ field: 'status', from: enumValue('ACTIVE'), to: enumValue('COMPLETED') }],
        context: { unitName: '4C' }
      })
    )

    expect(plain(sentence)).toBe('Tunde Bakare changed the sale on unit 4C from Active to Completed')
  })

  it('cancels a sale, with the reason, before any cancel flow exists', () => {
    // There is no cancellation path in the app yet. The verb is here so the
    // first cancellation ever recorded reads correctly, rather than falling
    // through to the generic sentence because nobody remembered this file.
    const { sentence } = describeAuditEntry(
      entry({
        action: 'sale.cancelled',
        entityType: 'Sale',
        entityId: 'sale_1',
        context: { unitName: '4C', reason: 'buyer withdrew' }
      })
    )

    expect(plain(sentence)).toBe('Tunde Bakare cancelled the sale on unit 4C — “buyer withdrew”')
  })

  it('changes a unit, listing only the fields that moved', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'unit.updated',
        entityType: 'Unit',
        entityId: 'unit_1',
        entityLabel: '4C',
        changes: [
          {
            field: 'priceMinor',
            from: money(14_500_000_000n, 'NGN'),
            to: money(14_900_000_000n, 'NGN')
          },
          { field: 'bedrooms', from: number(3), to: number(4) }
        ],
        context: { projectId: 'project_1', unitId: 'unit_1' }
      })
    )

    expect(plain(sentence)).toBe(
      'Tunde Bakare changed unit 4C — price NGN 145,000,000.00 → NGN 149,000,000.00, bedrooms 3 → 4'
    )
  })

  it('takes a unit out of inventory', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'unit.status_changed',
        entityType: 'Unit',
        entityId: 'unit_1',
        entityLabel: '4C',
        changes: [{ field: 'status', from: enumValue('AVAILABLE'), to: enumValue('SOLD') }]
      })
    )

    expect(plain(sentence)).toBe('Tunde Bakare changed unit 4C from Available to Sold')
  })

  it('creates a project, with the inventory it generated', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'project.created',
        entityType: 'Project',
        entityId: 'project_1',
        entityLabel: 'Khaleel Suites',
        context: { unitCount: 64 }
      })
    )

    expect(plain(sentence)).toBe('Tunde Bakare created the project Khaleel Suites with 64 units')
  })

  it('sets a building photo without printing its URL', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'project.updated',
        entityType: 'Project',
        entityId: 'project_1',
        entityLabel: 'Khaleel Suites',
        changes: [
          { field: 'heroImageUrl', from: image(null), to: image('https://cdn.test/tower.jpg') }
        ]
      })
    )

    expect(plain(sentence)).toBe('Tunde Bakare changed the project Khaleel Suites — building photo set')
    expect(sentence).not.toContain('cdn.test')
  })

  it('issues a document, by type and number', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'document.issued',
        entityType: 'Document',
        entityId: 'doc_1',
        entityLabel: 'RCP-000031',
        context: { saleId: 'sale_1', unitName: '4C', documentNumber: 'RCP-000031', documentType: 'RECEIPT' }
      })
    )

    expect(plain(sentence)).toBe('Tunde Bakare issued receipt RCP-000031 on unit 4C')
  })

  it('adds, registers and deactivates people', () => {
    const added = describeAuditEntry(
      entry({ action: 'user.agent_added', entityType: 'User', entityId: 'u2', entityLabel: 'Chidi Okeke' })
    )
    const deactivated = describeAuditEntry(
      entry({
        action: 'user.agent_deactivated',
        entityType: 'User',
        entityId: 'u2',
        entityLabel: 'Chidi Okeke'
      })
    )
    const registered = describeAuditEntry(
      entry({
        action: 'user.buyer_registered',
        entityType: 'User',
        entityId: 'u3',
        entityLabel: 'Amina Yusuf'
      })
    )

    expect(plain(added.sentence)).toBe('Tunde Bakare added Chidi Okeke as an agent')
    expect(plain(deactivated.sentence)).toBe('Tunde Bakare deactivated the agent Chidi Okeke')
    expect(plain(registered.sentence)).toBe('Tunde Bakare registered the buyer Amina Yusuf')
  })

  it('says a password change and a password reset differently', () => {
    // They are different events with different proofs behind them — a change
    // proves the old password, a reset proves control of the mailbox — and the
    // person reading the log after an incident needs to know which happened.
    const changed = describeAuditEntry(
      entry({ action: 'user.password_changed', entityType: 'User', entityId: 'u1', entityLabel: 'Tunde Bakare' })
    )
    const reset = describeAuditEntry(
      entry({ action: 'user.password_reset', entityType: 'User', entityId: 'u1', entityLabel: 'Tunde Bakare' })
    )

    expect(plain(changed.sentence)).toBe('Tunde Bakare changed their own password')
    expect(plain(reset.sentence)).toBe('Tunde Bakare reset their password with an emailed link')
  })

  it('changes a role, before any role-change flow exists', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'user.role_changed',
        entityType: 'User',
        entityId: 'u2',
        entityLabel: 'Chidi Okeke',
        changes: [{ field: 'role', from: enumValue('AGENT'), to: enumValue('ADMIN') }]
      })
    )

    expect(plain(sentence)).toBe('Tunde Bakare changed Chidi Okeke’s role from Agent to Admin')
  })

  it('sets the organisation letterhead', () => {
    const { sentence } = describeAuditEntry(
      entry({
        action: 'org.updated',
        entityType: 'Organization',
        entityId: 'org_1',
        entityLabel: null,
        changes: [{ field: 'logoUrl', from: image(null), to: image('https://cdn.test/logo.png') }]
      })
    )

    expect(plain(sentence)).toBe('Tunde Bakare changed the organisation — logo set')
  })

  it('stays readable for a verb it has never seen', () => {
    // An entry written by a newer build must not render as JSON or throw on an
    // older page — and adding a verb must never be blocked on remembering to
    // extend the renderer.
    const { sentence } = describeAuditEntry(
      entry({
        action: 'reservation.expired',
        entityType: 'Sale',
        entityId: 'sale_9',
        entityLabel: '7B',
        changes: [{ field: 'status', from: enumValue('RESERVED'), to: enumValue('AVAILABLE') }]
      })
    )

    expect(plain(sentence)).toBe(
      'Tunde Bakare performed reservation.expired on sale 7B — status Reserved → Available'
    )
  })
})

describe('an entry describes the past, not the present', () => {
  it('still names the unit as it was when the unit has since been renamed', () => {
    // The unit is called 4C-PH today. The entry was written when it was 4C, and
    // says 4C — because the renderer reads the entry's own snapshot and never
    // the live row. If this ever fails, the log has started rewriting history
    // every time somebody edits a name.
    const { sentence } = describeAuditEntry(
      entry({
        action: 'payment.voided',
        entityLabel: '4C',
        context: {
          saleId: 'sale_1',
          unitName: '4C',
          currency: 'KES',
          amountMinor: '18333333',
          reason: 'duplicate entry'
        }
      })
    )

    expect(plain(sentence)).toContain('on unit 4C')
    expect(sentence).not.toContain('4C-PH')
  })

  it('still names the actor and the role they held, after they are deactivated', () => {
    const { sentence } = describeAuditEntry(
      entry({ actorName: 'Chidi Okeke', actorRole: 'AGENT', action: 'payment.recorded', context: { currency: 'NGN', amountMinor: '100000', unitName: '4C' } })
    )

    expect(plain(sentence)).toBe('Chidi Okeke recorded a NGN 1,000.00 payment on unit 4C')
  })
})

describe('where a row links', () => {
  it('links a sale, a unit and a project to their own pages', () => {
    expect(
      describeAuditEntry(entry({ entityType: 'Sale', entityId: 'sale_1' })).href
    ).toBe('/sales/sale_1')
    expect(
      describeAuditEntry(
        entry({ entityType: 'Unit', entityId: 'unit_1', context: { projectId: 'project_1' } })
      ).href
    ).toBe('/projects/project_1/units/unit_1')
    expect(
      describeAuditEntry(entry({ entityType: 'Project', entityId: 'project_1' })).href
    ).toBe('/projects/project_1')
  })

  it('links a payment and a document to the sale they belong to', () => {
    // Neither has a page of its own, and the sale is where an admin goes to see
    // what happened to it.
    expect(
      describeAuditEntry(entry({ entityType: 'Payment', context: { saleId: 'sale_1' } })).href
    ).toBe('/sales/sale_1')
    expect(
      describeAuditEntry(
        entry({ entityType: 'Document', entityId: 'doc_1', context: { saleId: 'sale_1' } })
      ).href
    ).toBe('/sales/sale_1')
  })

  it('links people and the organisation to the team page', () => {
    expect(describeAuditEntry(entry({ entityType: 'User', entityId: 'u2' })).href).toBe('/team')
    expect(
      describeAuditEntry(entry({ entityType: 'Organization', entityId: 'org_1' })).href
    ).toBe('/team')
  })

  it('offers no link at all when the id it would need was never captured', () => {
    // A link that 404s is worse than no link.
    expect(describeAuditEntry(entry({ entityType: 'Payment', context: {} })).href).toBeNull()
    expect(
      describeAuditEntry(entry({ entityType: 'Unit', entityId: 'unit_1', context: {} })).href
    ).toBeNull()
  })
})
