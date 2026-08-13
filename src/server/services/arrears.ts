import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { daysLate, deriveStatus, outstandingMinor } from '@/domain/status'

export interface ArrearsRow {
  saleId: string
  /**
   * Who owes it, not just what they are called. A row is one *contract*, and one
   * buyer can hold two, so the "buyers overdue" figure on the report has to
   * count distinct people rather than rows. `Buyer.email` carries no unique
   * constraint (see schema.prisma), so the id is the only honest key.
   */
  buyerId: string
  buyerName: string
  buyerPhone: string
  buyerEmail: string
  /** The project this contract belongs to — the key the report filters on. */
  projectId: string
  projectName: string
  unitName: string
  currency: string
  overdueCount: number
  overdueAmountMinor: bigint
  oldestDueDate: Date
  daysLate: number
}

interface ArrearsSale {
  id: string
  currency: string
  buyer: { id: string; fullName: string; phone: string; email: string }
  project: { id: string; name: string }
  unit: { name: string }
  scheduleEntries: Array<{ dueDate: Date; amountDueMinor: bigint; amountPaidMinor: bigint }>
}

/** Pure: takes sales, returns rows. Sorted worst-first. */
export function buildArrearsRows(sales: ArrearsSale[], asOf: Date): ArrearsRow[] {
  const rows: ArrearsRow[] = []

  for (const sale of sales) {
    const overdue = sale.scheduleEntries.filter((e) => deriveStatus(e, asOf) === 'OVERDUE')
    if (overdue.length === 0) continue

    const oldest = overdue.reduce((a, b) => (a.dueDate <= b.dueDate ? a : b))

    rows.push({
      saleId: sale.id,
      buyerId: sale.buyer.id,
      buyerName: sale.buyer.fullName,
      buyerPhone: sale.buyer.phone,
      buyerEmail: sale.buyer.email,
      projectId: sale.project.id,
      projectName: sale.project.name,
      unitName: sale.unit.name,
      currency: sale.currency,
      overdueCount: overdue.length,
      overdueAmountMinor: overdue.reduce((sum, e) => sum + outstandingMinor(e), 0n),
      oldestDueDate: oldest.dueDate,
      daysLate: daysLate(oldest, asOf)
    })
  }

  return rows.sort((a, b) => b.daysLate - a.daysLate)
}

export interface ArrearsFilter {
  /**
   * One project instead of the whole organisation. Optional, and an id that
   * belongs to another organisation simply matches nothing — `orgId` is still in
   * the predicate below, so this narrows the scope and can never widen it.
   *
   * Additive: `arrearsReport(actor, asOf)` is unchanged, and the report screen
   * and its CSV export pass the same filter so a shared URL and its download
   * cannot disagree.
   */
  projectId?: string
}

export async function arrearsReport(
  actor: SessionActor,
  asOf: Date,
  filter: ArrearsFilter = {}
): Promise<ArrearsRow[]> {
  assertRole(actor, ['ADMIN', 'AGENT'])

  // Narrow in SQL first — only sales with at least one past-due unsettled entry
  // reach the pure function. Status is derived, so this filter is the query.
  const sales = await prisma.sale.findMany({
    where: {
      orgId: actor.orgId,
      status: 'ACTIVE',
      scheduleEntries: { some: { dueDate: { lt: asOf } } },
      // Spread rather than `projectId: filter.projectId`: an explicit
      // `undefined` is what Prisma treats as "no condition", but writing it out
      // leaves a reader unsure whether an empty string would match everything or
      // nothing. Absent means absent.
      ...(filter.projectId ? { projectId: filter.projectId } : {})
    },
    select: {
      id: true,
      currency: true,
      buyer: { select: { id: true, fullName: true, phone: true, email: true } },
      project: { select: { id: true, name: true } },
      unit: { select: { name: true } },
      scheduleEntries: {
        select: { dueDate: true, amountDueMinor: true, amountPaidMinor: true }
      }
    }
  })

  return buildArrearsRows(sales, asOf)
}
