import type { Prisma, UnitStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { toMinor } from '@/domain/currency'

export interface InventoryUnit {
  id: string
  name: string
  floor: number
  bedrooms: number
  sizeSqm: string
  priceMinor: bigint
  status: UnitStatus
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
    include: { units: { orderBy: [{ floor: 'asc' }, { name: 'asc' }] } }
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
      status: unit.status
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
  sizeSqm: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  price: z.string().optional()
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
    // snapshot and are untouched by this.
    data.priceMinor = toMinor(patch.price, unit.project.currency)
  }

  try {
    return await prisma.unit.update({ where: { id: unitId }, data })
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      throw new ServiceError(`Another unit in this project is already named "${patch.name}"`, 'CONFLICT')
    }
    throw error
  }
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
