import { Prisma, type UnitStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { ImageUrlField, RenderUrlsField } from '@/server/services/media'
import { deleteReplacedBlobs } from '@/server/media/blob'
import { toMinor } from '@/domain/currency'
import { ownedBlobPathname } from '@/domain/uploads'
import type { InstallmentFeeMode } from '@/domain/schedule'
import { recordAudit } from '@/server/audit/record'
import { diffValues, image, money, number, text, type AuditFields } from '@/domain/audit'

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
  /** The floor plan, or null — the row shows a thumbnail only when it is set. */
  layoutImageUrl: string | null
  /** Artist's impressions, in the admin's order. Empty is the common case. */
  renderImageUrls: string[]
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
    /** The building photo, for the banner at the top of the inventory page. */
    heroImageUrl: string | null
    /**
     * The project's default installment charge — the mode and both values, so
     * the inventory page can state what a "Sell" from one of these rows will
     * default to. Otherwise the only place it is ever visible is the sale form
     * itself, which is too late for staff to notice a project is still set to
     * 0%, or still on a percentage in a market that cannot charge one.
     */
    installmentFeeMode: InstallmentFeeMode
    installmentMarkupBps: number
    installmentFixedFeeMinor: bigint
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
      layoutImageUrl: unit.layoutImageUrl,
      renderImageUrls: unit.renderImageUrls,
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
      namingPattern: project.namingPattern,
      heroImageUrl: project.heroImageUrl,
      installmentFeeMode: project.installmentFeeMode,
      installmentMarkupBps: project.installmentMarkupBps,
      installmentFixedFeeMinor: project.installmentFixedFeeMinor
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
  price: z.string().regex(PRICE_PATTERN, 'Invalid amount').optional(),
  // Both `.optional()`, and both able to parse to an *empty* value: absent means
  // "the form did not carry this field, leave the column alone", while present
  // and blank means "clear it" — null for the layout, [] for the renders. The
  // action reads them with `imageFieldFrom`, which is what preserves that
  // distinction across the FormData boundary.
  layoutImageUrl: ImageUrlField.optional(),
  renderImageUrls: RenderUrlsField.optional()
})

/**
 * A unit's auditable state, in the tagged values the log diffs.
 *
 * One function for both sides of the comparison, so "before" and "after" can
 * never be built out of different field sets — which is how a diff quietly
 * stops reporting a field. `sizeSqm` is a Prisma `Decimal`, so it is compared
 * as its own string rather than as a float; `renderImageUrls` is compared as a
 * count, because "3 renders → 2 renders" is what a reader wants and a list of
 * signed blob URLs is not.
 *
 * `status` is in the set even though `UpdateUnitSchema` cannot change it today.
 * That is the point: the day a status control appears on the unit form, it is
 * audited because it was already being compared, rather than because somebody
 * remembered to come back here.
 */
function auditFieldsForUnit(
  unit: {
    name: string
    bedrooms: number
    sizeSqm: { toString(): string }
    priceMinor: bigint
    status: UnitStatus
    layoutImageUrl: string | null
    renderImageUrls: string[]
  },
  currency: string
): AuditFields {
  return {
    name: text(unit.name),
    priceMinor: money(unit.priceMinor, currency),
    bedrooms: number(unit.bedrooms),
    sizeSqm: text(unit.sizeSqm.toString()),
    status: { kind: 'enum', value: unit.status },
    layoutImageUrl: image(unit.layoutImageUrl),
    renderImageUrls: number(unit.renderImageUrls.length)
  }
}

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
  // null here is a real value, not an absence — it is how the URL is cleared —
  // so the guard is `!== undefined`, never a truthiness check.
  if (patch.layoutImageUrl !== undefined) data.layoutImageUrl = patch.layoutImageUrl
  if (patch.renderImageUrls !== undefined) data.renderImageUrls = patch.renderImageUrls
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

  let updated
  try {
    // The update and its audit entry commit together. Before this, `updateUnit`
    // was a bare `prisma.unit.update`; wrapping it changes nothing a caller can
    // observe — the same row is returned, and a P2002 still escapes to be
    // translated below — but it makes "a price changed with no record of who
    // changed it" unreachable rather than merely unlikely.
    updated = await prisma.$transaction(async (tx) => {
      const row = await tx.unit.update({ where: { id: unitId }, data })

      // Only what moved. `diffValues` compares the two states field by field,
      // so an admin who saves the form having edited nothing but the bedrooms
      // gets an entry that says bedrooms and nothing else — which is the whole
      // difference between a log people read and a log people ignore.
      const before: AuditFields = auditFieldsForUnit(unit, unit.project.currency)
      const after: AuditFields = auditFieldsForUnit(row, unit.project.currency)
      const changes = diffValues(before, after)

      // A save that changed nothing is not an event. Recording it would fill
      // the largest table in the database with rows that say "somebody pressed
      // Save", which is exactly the noise automatic capture was rejected for.
      if (changes.length > 0) {
        await recordAudit(tx, actor, {
          action: 'unit.updated',
          entityType: 'Unit',
          entityId: row.id,
          // The name *after* the edit, so a renamed unit's entry names what it
          // became. The rename itself is in `changes`, which is where the old
          // name is preserved.
          entityLabel: row.name,
          changes,
          context: {
            projectId: row.projectId,
            unitId: row.id,
            unitName: row.name,
            currency: unit.project.currency
          }
        })
      }

      return row
    })
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

  // Only once the row no longer points at them. Both fields are swept in one
  // call, and the comparison is by *set* rather than by position — an admin who
  // removes the middle render of three leaves two URLs that must survive, and
  // pairing them up by index would delete the wrong one. Anything that is not
  // this org's own blob (a pasted external link, another tenant's blob) is left
  // alone; see `deleteReplacedBlobs`.
  await deleteReplacedBlobs(
    [unit.layoutImageUrl, ...unit.renderImageUrls],
    [updated.layoutImageUrl, ...updated.renderImageUrls],
    actor.orgId
  )

  return updated
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

export const AssignLayoutSchema = z.object({
  projectId: z.string().min(1),
  imageUrl: z.string().url(),
  // A ceiling rather than an unbounded list: one project's units, not a
  // request that asks the database to update every row it can name.
  unitIds: z.array(z.string().min(1)).min(1, 'Choose at least one unit.').max(500)
})

/**
 * One drawing onto many units, in a single transaction with a single audit
 * entry.
 *
 * This is what makes the PDF import worth having: page 23 of a developer's
 * brochure is *the* 3-bedroom plan, and there are twenty-four 3-bedroom units.
 * Assigning it unit by unit would be twenty-four writes, twenty-four audit rows
 * and twenty-four chances to stop halfway.
 *
 * Three things are checked before anything is written, and each is checked
 * against the database rather than against what the browser claimed:
 *
 *   1. the project belongs to the actor's organisation;
 *   2. every unit id belongs to *that* project — a partial match is refused
 *      outright rather than silently assigning the subset that resolved;
 *   3. the image is a blob this organisation uploaded. `ownedBlobPathname`
 *      returns null for a pasted external URL and for another tenant's blob
 *      alike, so a crafted request cannot point a unit's drawing at a host we
 *      do not control.
 *
 * **No blob sweep.** `updateUnit` calls `deleteReplacedBlobs` so a replaced
 * drawing does not linger; this deliberately does not. Under group assignment
 * many units share one URL, so deleting "the old one" per unit would delete a
 * blob the units *not* in this batch still point at — and a buyer's floor-plan
 * PDF would then say no plan exists for a unit that has one. An orphaned blob
 * costs storage. A deleted one that is still referenced costs the document.
 */
export async function assignLayoutToUnits(
  actor: SessionActor,
  input: z.infer<typeof AssignLayoutSchema>
): Promise<{ assigned: number }> {
  assertRole(actor, ['ADMIN'])

  const parsed = AssignLayoutSchema.safeParse(input)
  if (!parsed.success) {
    throw new ServiceError(
      parsed.error.issues[0]?.message ?? 'Choose at least one unit.',
      'VALIDATION'
    )
  }

  const project = await prisma.project.findFirst({
    where: { id: parsed.data.projectId, orgId: actor.orgId },
    select: { id: true, name: true }
  })
  if (!project) throw new ServiceError('Project not found', 'NOT_FOUND')

  if (ownedBlobPathname(parsed.data.imageUrl, actor.orgId) === null) {
    throw new ServiceError('That image is not one this organisation uploaded.', 'VALIDATION')
  }

  const units = await prisma.unit.findMany({
    where: { id: { in: parsed.data.unitIds }, projectId: project.id },
    select: { id: true }
  })
  if (units.length !== parsed.data.unitIds.length) {
    throw new ServiceError('Some of those units are not in this project.', 'VALIDATION')
  }

  const ids = units.map((unit) => unit.id)

  await prisma.$transaction(async (tx) => {
    await tx.unit.updateMany({
      where: { id: { in: ids } },
      data: { layoutImageUrl: parsed.data.imageUrl }
    })

    // No `changes` array. Across twenty-four units the previous value differs
    // per unit — some had no plan, some had an older one — so a single
    // before/after pair would be true of some and a lie about the rest. The
    // sentence and the count are honest; a fabricated diff would not be.
    await recordAudit(tx, actor, {
      action: 'unit.layout_assigned',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: project.name,
      context: {
        projectId: project.id,
        projectName: project.name,
        unitCount: ids.length
      }
    })
  })

  return { assigned: ids.length }
}
