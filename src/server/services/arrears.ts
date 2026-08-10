import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { daysLate, deriveStatus, outstandingMinor } from '@/domain/status'

export interface ArrearsRow {
  saleId: string
  buyerName: string
  buyerPhone: string
  buyerEmail: string
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
  buyer: { fullName: string; phone: string; email: string }
  project: { name: string }
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
      buyerName: sale.buyer.fullName,
      buyerPhone: sale.buyer.phone,
      buyerEmail: sale.buyer.email,
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

export async function arrearsReport(actor: SessionActor, asOf: Date): Promise<ArrearsRow[]> {
  assertRole(actor, ['ADMIN', 'AGENT'])

  // Narrow in SQL first — only sales with at least one past-due unsettled entry
  // reach the pure function. Status is derived, so this filter is the query.
  const sales = await prisma.sale.findMany({
    where: {
      orgId: actor.orgId,
      status: 'ACTIVE',
      scheduleEntries: { some: { dueDate: { lt: asOf } } }
    },
    select: {
      id: true,
      currency: true,
      buyer: { select: { fullName: true, phone: true, email: true } },
      project: { select: { name: true } },
      unit: { select: { name: true } },
      scheduleEntries: {
        select: { dueDate: true, amountDueMinor: true, amountPaidMinor: true }
      }
    }
  })

  return buildArrearsRows(sales, asOf)
}
