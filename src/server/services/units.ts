import { Prisma, type UnitStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { toMinor } from '@/domain/currency'

/**
 * Shared with projects.ts's `defaultSizeSqm` — one pattern, one message, so
 * the two schemas can never drift on what a valid size string looks like.
 */
export const SIZE_SQM_PATTERN = /^\d+(\.\d{1,2})?$/
export const SIZE_SQM_MESSAGE = 'Invalid size'

/**
 * Schema-level shape check only — this cannot know which currency the unit's
 * project uses, so it rejects obvious garbage (letters, multiple dots) but
 * not "too many decimal places for this currency". That check needs the
 * loaded unit and happens in updateUnit() below via toMinor().
 */
const PRICE_PATTERN = /^\d+(\.\d+)?$/

export interface InventoryUnit {
  id: string
  name: string
  floor: number
  bedrooms: number
  sizeSqm: string
  priceMinor: bigint
  status: UnitStatus
  /**
   * The sale that claimed this unit, or null while no sale references it.
   * Carried so an inventory row can link straight to its sale: before this,
   * the arrears report was the only route to /sales/[id], so staff could not
   * open the sale of any buyer who was not overdue. `Sale.unitId` is
   * `@unique`, so there is at most one sale per unit.
   */
  saleId: string | null
}

export interface ProjectInventory {
  project: {
    id: string
    name: string
    location: string
    currency: string
    expectedCompletion: Date
    namingPattern: string
  }
  floors: Array<{ floor: number; units: InventoryUnit[]; available: number; total: number }>
  totals: { total: number; available: number; reserved: number; sold: number }
}

export async function getProjectInventory(
  actor: SessionActor,
  projectId: string
): Promise<ProjectInventory> {
  // Scoped by actor.orgId — never trust projectId alone. A project from
  // another organisation must come back NOT_FOUND, not leak as data.
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId: actor.orgId },
    include: {
      units: {
        orderBy: [{ floor: 'asc' }, { name: 'asc' }],
        // Only the sale's id — nothing about the buyer or the money belongs in
        // an inventory listing. It exists purely so the row can link to it.
        include: { sale: { select: { id: true } } }
      }
    }
  })
  if (!project) throw new ServiceError('Project not found', 'NOT_FOUND')

  const byFloor = new Map<number, InventoryUnit[]>()
  for (const unit of project.units) {
    const entry: InventoryUnit = {
      id: unit.id,
      name: unit.name,
      floor: unit.floor,
      bedrooms: unit.bedrooms,
      sizeSqm: unit.sizeSqm.toString(),
      priceMinor: unit.priceMinor,
      status: unit.status,
      saleId: unit.sale?.id ?? null
    }
    byFloor.set(unit.floor, [...(byFloor.get(unit.floor) ?? []), entry])
  }

  const floors = [...byFloor.entries()]
    .sort((a, b) => b[0] - a[0]) // top floor first, as a floor plan reads
    .map(([floor, units]) => ({
      floor,
      units,
      available: units.filter((u) => u.status === 'AVAILABLE').length,
      total: units.length
    }))

  return {
    project: {
      id: project.id,
      name: project.name,
      location: project.location,
      currency: project.currency,
      expectedCompletion: project.expectedCompletion,
      namingPattern: project.namingPattern
    },
    floors,
    totals: {
      total: project.units.length,
      available: project.units.filter((u) => u.status === 'AVAILABLE').length,
      reserved: project.units.filter((u) => u.status === 'RESERVED').length,
      sold: project.units.filter((u) => u.status === 'SOLD').length
    }
  }
}

export const UpdateUnitSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  bedrooms: z.coerce.number().int().min(0).max(10).optional(),
  sizeSqm: z.string().regex(SIZE_SQM_PATTERN, SIZE_SQM_MESSAGE).optional(),
  price: z.string().regex(PRICE_PATTERN, 'Invalid amount').optional()
})

export async function updateUnit(
  actor: SessionActor,
  unitId: string,
  patch: z.infer<typeof UpdateUnitSchema>
) {
  assertRole(actor, ['ADMIN'])

  const unit = await prisma.unit.findFirst({
    where: { id: unitId, project: { orgId: actor.orgId } },
    include: { project: { select: { currency: true } } }
  })
  if (!unit) throw new ServiceError('Unit not found', 'NOT_FOUND')

  const data: Prisma.UnitUpdateInput = {}
  if (patch.name !== undefined) data.name = patch.name
  if (patch.bedrooms !== undefined) data.bedrooms = patch.bedrooms
  if (patch.sizeSqm !== undefined) data.sizeSqm = patch.sizeSqm
  if (patch.price !== undefined) {
    // Repricing affects new sales only — existing Sale rows hold their own
    // snapshot and are untouched by this. The schema only checked numeric
    // shape; currency-aware validation (e.g. RWF has zero decimal places)
    // needs the project loaded above, so it happens here.
    try {
      data.priceMinor = toMinor(patch.price, unit.project.currency)
    } catch (error) {
      throw new ServiceError(error instanceof Error ? error.message : 'Invalid price', 'VALIDATION')
    }
  }

  try {
    return await prisma.unit.update({ where: { id: unitId }, data })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      constraintTargetIncludes(error.meta?.target, 'name')
    ) {
      throw new ServiceError(`Another unit in this project is already named "${patch.name}"`, 'CONFLICT')
    }
    throw error
  }
}

/**
 * `error.meta.target` identifies which columns a violated unique constraint
 * covers. On Postgres it's usually a string[] of column names, but Prisma
 * doesn't guarantee that shape across engines/versions, so this checks
 * defensively rather than assuming an array. Only a target that actually
 * involves `column` may be reported as that kind of conflict — otherwise a
 * P2002 on some other constraint would get mislabeled. Shared with
 * sales.ts's duplicate-email check on registerBuyer, so both P2002 sites
 * agree on how a violated column is identified.
 */
export function constraintTargetIncludes(target: unknown, column: string): boolean {
  if (typeof target === 'string') return target === column
  if (Array.isArray(target)) return target.includes(column)
  return false
}

/**
 * Conditional status transition. Returns false when another agent got there
 * first — a zero row count, not a thrown error, because losing the race is an
 * expected outcome rather than a fault.
 */
export async function reserveUnit(
  tx: Prisma.TransactionClient,
  unitId: string,
  to: 'RESERVED' | 'SOLD'
): Promise<boolean> {
  const result = await tx.unit.updateMany({
    where: { id: unitId, status: 'AVAILABLE' },
    data: { status: to }
  })
  return result.count === 1
}
