import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { isSupportedCurrency, toMinor } from '@/domain/currency'
import { UNIT_TYPE_FIELDS, generateUnitNames, UnitPatternError } from '@/domain/units'
import { percentToBps } from '@/domain/schedule'
import { SIZE_SQM_PATTERN, SIZE_SQM_MESSAGE } from '@/server/services/units'
import { ImageUrlField } from '@/server/services/media'
import { deleteReplacedBlobs } from '@/server/media/blob'
import { recordAudit } from '@/server/audit/record'
import { diffValues, image } from '@/domain/audit'

const MAX_UNITS = 2000

/** Validates that a major-unit string is parseable in the chosen currency. */
function moneyString(field: string) {
  return z.string().min(1, `${field} is required`)
}

/**
 * One unit position on a floor: its bedrooms, its size and its price.
 *
 * Real buildings are not one repeated flat. The owner's own — Khaleel Suites —
 * has four positions per floor and three distinct types among them (4-bed
 * 245m², 4-bed 245m², 4-bed 240m², 3-bed 210m²); other buildings have eight or
 * more, mixing 1-bed through 4-bed. The single `defaultBedrooms` /
 * `defaultSizeSqm` / `defaultPrice` triple this replaces could express none of
 * it, and the seed only worked around the gap with an `(indexOnFloor % 3) + 1`
 * hack.
 *
 * Deliberately *not* a `UnitType` table. These values are a generation-time
 * input and nothing more: `createProject` reads row *i* to stamp the unit at
 * `indexOnFloor` *i* on every floor, and from that moment each unit is edited
 * on its own page exactly as before. A table would give a lifetime — and raise
 * the question of what happens to already-generated units when a "type" is
 * edited — to something that has no lifetime at all. So: no schema change.
 */
export const UnitTypeRowSchema = z.object({
  bedrooms: z.coerce.number().int().min(0).max(10),
  sizeSqm: z.string().regex(SIZE_SQM_PATTERN, SIZE_SQM_MESSAGE),
  price: moneyString('Price')
})

export type UnitTypeRow = z.infer<typeof UnitTypeRowSchema>

/**
 * The posted rows, read out of those three repeated fields.
 *
 * `Object.fromEntries(formData)` — what the action uses for every other field —
 * keeps only the last value of a repeated name, so the rows have to be read
 * with `getAll` and zipped back together here.
 *
 * The row count is the *longest* of the three lists, not the shortest: a ragged
 * post (a row whose price input never arrived) then produces a row with a blank
 * that fails validation against its own position, rather than silently pairing
 * position 4's bedrooms with position 5's price.
 */
export function unitTypeRowsFrom(formData: FormData): Array<Record<string, string>> {
  const bedrooms = formData.getAll(UNIT_TYPE_FIELDS.bedrooms)
  const sizes = formData.getAll(UNIT_TYPE_FIELDS.sizeSqm)
  const prices = formData.getAll(UNIT_TYPE_FIELDS.price)
  const count = Math.max(bedrooms.length, sizes.length, prices.length)

  return Array.from({ length: count }, (_unused, index) => ({
    bedrooms: String(bedrooms[index] ?? ''),
    sizeSqm: String(sizes[index] ?? ''),
    price: String(prices[index] ?? '')
  }))
}

/** One wording for a row-count mismatch, shared by the schema and the service. */
function unitTypeCountMessage(submitted: number, unitsPerFloor: number): string {
  const plural = unitsPerFloor === 1 ? '' : 's'
  return (
    `This project has ${unitsPerFloor} unit${plural} per floor, so it needs ` +
    `${unitsPerFloor} unit position${plural} — ${submitted} ` +
    `${submitted === 1 ? 'was' : 'were'} submitted. ` +
    'Set “Units / floor” and the list of positions to the same number.'
  )
}

export const CreateProjectSchema = z
  .object({
    name: z.string().min(2).max(120),
    location: z.string().min(2).max(200),
    currency: z.string().refine(isSupportedCurrency, 'Unsupported currency'),
    expectedCompletion: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
    floors: z.coerce.number().int().min(1).max(200),
    unitsPerFloor: z.coerce.number().int().min(1).max(100),
    startFloor: z.coerce.number().int().min(0).max(200),
    namingPattern: z.string().min(1),
    // Optional, and blank is the ordinary case: a developer creating a project
    // rarely has the photo to hand at that moment. `.default('')` so a form that
    // omits the field entirely still parses (the field parses '' to null), which
    // keeps every existing caller and test working unchanged.
    heroImageUrl: ImageUrlField.default(''),
    /**
     * One row per unit position, in `indexOnFloor` order — row 1 is the unit
     * `generateUnitNames` numbers 1 on every floor (the A / 01 unit), row 2 the
     * B / 02 one, and so on. The length must equal `unitsPerFloor`; that is
     * checked in the superRefine below, because it is a rule about two fields
     * rather than about this one.
     */
    unitTypes: z.array(UnitTypeRowSchema).min(1, 'Add at least one unit position').max(100),
    // How this project charges for paying by installments. PERCENT is the
    // default because it is what most markets use; FIXED exists because a
    // percentage of the financed amount is interest, and interest is not
    // permissible everywhere this platform is sold — see `InstallmentFeeMode`
    // in schema.prisma. Blank reads as PERCENT, so every caller that omits the
    // field keeps the behaviour it had before FIXED existed.
    installmentFeeMode: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? 'PERCENT' : value),
      z.enum(['PERCENT', 'FIXED'])
    ),
    // The PERCENT rate — entered as a percentage because that is how staff
    // quote it, stored as basis points because that is the only representation
    // the money core holds exactly. Blank reads as 0: a project that charges
    // nothing is the ordinary case, not a validation error. It stays a string
    // through the schema (percentToBps parses the digits, never a float) and is
    // converted once in createProject, exactly as defaultPrice is.
    installmentMarkupPercent: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? '0' : value),
      z.string()
    ),
    // The FIXED amount, in this project's currency and major units — the same
    // shape as defaultPrice, and converted the same way, by toMinor against
    // this project's currency. Never a float: a zero-decimal currency (RWF,
    // UGX) and a two-decimal one are 100x apart, which is exactly what toMinor
    // exists to get right.
    installmentFixedFee: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? '0' : value),
      z.string()
    ),
    reminderDaysBefore: z.coerce.number().int().min(0).max(60),
    overdueNoticeDaysAfter: z.coerce.number().int().min(0).max(60)
  })
  .superRefine((value, ctx) => {
    if (value.floors * value.unitsPerFloor > MAX_UNITS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitsPerFloor'],
        message: `A project cannot exceed ${MAX_UNITS} units`
      })
    }

    // The rows are what the building is made of, so one row per position and
    // no fewer. A mismatch is refused outright rather than truncated or padded:
    // a project generated from four rows when the admin meant eight is a wrong
    // building that looks right, and it is 64 units too late to notice.
    if (value.unitTypes.length !== value.unitsPerFloor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitTypes'],
        message: unitTypeCountMessage(value.unitTypes.length, value.unitsPerFloor)
      })
    }

    // Currency-aware price validation, per position: '100.50' is valid NGN but
    // invalid RWF. The issue is raised against its own row, so the form can say
    // which position is wrong instead of pointing at the first one.
    value.unitTypes.forEach((row, index) => {
      try {
        toMinor(row.price, value.currency)
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unitTypes', index, 'price'],
          message: error instanceof Error ? error.message : 'Invalid price'
        })
      }
    })

    // Only the field the chosen mode actually uses is validated. The other is
    // carried at whatever the form left in it and stored as its zero, so a
    // developer switching a project from 10% to a flat fee is not made to
    // "fix" a percentage nobody is going to charge.
    if (value.installmentFeeMode === 'PERCENT') {
      // The percent -> basis-point conversion has to be exact, so anything the
      // conversion cannot hold — a third decimal place, a negative, above 100%
      // — is a form error here rather than a ScheduleError from deep inside
      // createProject. Same shape as the price check above, and for the same
      // reason: the schema owns "can this be converted", the service owns the
      // conversion.
      try {
        percentToBps(value.installmentMarkupPercent)
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['installmentMarkupPercent'],
          message: error instanceof Error ? error.message : 'Invalid installment charge'
        })
      }
    } else {
      // Currency-aware, exactly like defaultPrice above: '2500000.50' is a
      // valid NGN fee and an invalid RWF one.
      try {
        const fixedMinor = toMinor(value.installmentFixedFee, value.currency)
        if (fixedMinor < 0n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['installmentFixedFee'],
            message: 'A fixed installment charge cannot be negative'
          })
        }
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['installmentFixedFee'],
          message: error instanceof Error ? error.message : 'Invalid installment charge'
        })
      }
    }

    // This probe only checks pattern *syntax* (floors: 1 deliberately skips
    // the cross-floor {floor}-token requirement and the duplicate-name
    // check that only bites once real floor/unitsPerFloor counts are used).
    // createProject() below re-validates with the real counts and must
    // itself turn a UnitPatternError into a clean ServiceError.
    try {
      generateUnitNames({
        floors: 1,
        unitsPerFloor: 1,
        pattern: value.namingPattern,
        startFloor: value.startFloor
      })
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['namingPattern'],
        message: error instanceof Error ? error.message : 'Invalid pattern'
      })
    }
  })

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>

export async function createProject(actor: SessionActor, input: CreateProjectInput) {
  assertRole(actor, ['ADMIN'])

  // Re-checked here as well as in the schema, and for the same reason the
  // naming pattern is: the service is a callable entry point in its own right
  // (the seed, a script, a future import), and "one row per position" is a rule
  // about the building, not about the form that happened to describe it.
  if (input.unitTypes.length !== input.unitsPerFloor) {
    throw new ServiceError(
      unitTypeCountMessage(input.unitTypes.length, input.unitsPerFloor),
      'VALIDATION'
    )
  }

  let drafts: ReturnType<typeof generateUnitNames>
  try {
    drafts = generateUnitNames({
      floors: input.floors,
      unitsPerFloor: input.unitsPerFloor,
      pattern: input.namingPattern,
      startFloor: input.startFloor
    })
  } catch (error) {
    if (error instanceof UnitPatternError) {
      throw new ServiceError(error.message, 'VALIDATION')
    }
    throw error
  }

  // Every row converted up front, before a single row is written: a project
  // that got as far as inserting units and then failed on position 7's price
  // would be rolled back by the transaction anyway, but there is no reason to
  // open one to discover it.
  const positions = input.unitTypes.map((row, index) => {
    try {
      return {
        bedrooms: row.bedrooms,
        sizeSqm: row.sizeSqm,
        priceMinor: toMinor(row.price, input.currency)
      }
    } catch (error) {
      throw new ServiceError(
        `Unit position ${index + 1}: ${error instanceof Error ? error.message : 'Invalid price'}`,
        'VALIDATION'
      )
    }
  })

  // The inactive mode's column is stored as its zero rather than as whatever
  // the form happened to carry, so a project's live charge is unambiguous from
  // the row alone and switching modes later cannot resurrect a stale figure.
  const isPercent = input.installmentFeeMode === 'PERCENT'
  const installmentMarkupBps = isPercent ? percentToBps(input.installmentMarkupPercent) : 0

  let installmentFixedFeeMinor = 0n
  if (!isPercent) {
    // Same pattern as `updateUnit`'s price: the schema checked the shape, the
    // service does the currency-aware conversion and turns a bad value into a
    // VALIDATION rather than letting a raw Error escape.
    try {
      installmentFixedFeeMinor = toMinor(input.installmentFixedFee, input.currency)
    } catch (error) {
      throw new ServiceError(
        error instanceof Error ? error.message : 'Invalid installment charge',
        'VALIDATION'
      )
    }
    if (installmentFixedFeeMinor < 0n) {
      throw new ServiceError('A fixed installment charge cannot be negative', 'VALIDATION')
    }
  }

  // One transaction: a project that half-generated its units is worse than one
  // that failed outright.
  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        orgId: actor.orgId,
        name: input.name,
        location: input.location,
        currency: input.currency.toUpperCase(),
        expectedCompletion: new Date(input.expectedCompletion),
        floors: input.floors,
        unitsPerFloor: input.unitsPerFloor,
        startFloor: input.startFloor,
        namingPattern: input.namingPattern,
        heroImageUrl: input.heroImageUrl,
        installmentFeeMode: input.installmentFeeMode,
        installmentMarkupBps,
        installmentFixedFeeMinor,
        reminderDaysBefore: input.reminderDaysBefore,
        overdueNoticeDaysAfter: input.overdueNoticeDaysAfter
      }
    })

    await tx.unit.createMany({
      // Row *i* applies to `indexOnFloor` *i* on every floor. That is the whole
      // mechanism: `generateUnitNames` already numbers each unit's position
      // within its floor, so the positions line up with the names it produced
      // without this having to know anything about the naming pattern. The
      // index is 1-based there and 0-based here; the length check above is what
      // makes the lookup total.
      data: drafts.map((draft) => {
        const position = positions[draft.indexOnFloor - 1]
        return {
          projectId: created.id,
          name: draft.name,
          floor: draft.floor,
          bedrooms: position.bedrooms,
          sizeSqm: position.sizeSqm,
          priceMinor: position.priceMinor
        }
      })
    })

    // Inside the same transaction that generated the building. There is no
    // diff — nothing existed a moment ago — so what the entry carries is the
    // shape of what was created: the name, and how many units it put into
    // inventory. The fee mode and rate are deliberately not spelled out here;
    // they are what the project *is*, not a change to it, and the day one is
    // re-rated `updateProjectImagery`'s sibling will diff them.
    await recordAudit(tx, actor, {
      action: 'project.created',
      entityType: 'Project',
      entityId: created.id,
      entityLabel: created.name,
      context: {
        projectId: created.id,
        projectName: created.name,
        currency: created.currency,
        unitCount: drafts.length
      }
    })

    return created
  })

  return { id: project.id, unitCount: drafts.length }
}

/**
 * The building photo, set after the fact.
 *
 * A whole project-settings surface is not what this needs — there is no
 * project-edit page today and inventing one to hold a single field would be the
 * wrong size of change. But without *some* edit path a hero URL could only ever
 * be set at creation, which means every project that already exists could never
 * have a photo. So: one field, one action, ADMIN only, on the page an admin is
 * already looking at when they think about the building.
 */
export const UpdateProjectImagerySchema = z.object({ heroImageUrl: ImageUrlField })

export type UpdateProjectImageryInput = z.infer<typeof UpdateProjectImagerySchema>

export async function updateProjectImagery(
  actor: SessionActor,
  projectId: string,
  input: UpdateProjectImageryInput
) {
  assertRole(actor, ['ADMIN'])

  // What is about to be replaced, read before the write so the old blob can be
  // swept afterwards. This read is *not* the authorisation check — the write
  // below still carries the orgId in its own predicate — so a project that
  // disappears between the two is caught by the count rather than missed.
  const before = await prisma.project.findFirst({
    where: { id: projectId, orgId: actor.orgId },
    select: { name: true, heroImageUrl: true }
  })

  await prisma.$transaction(async (tx) => {
    // Org-scoped, and scoped in the write itself rather than by a
    // read-then-write: `updateMany` with the orgId in the predicate cannot be
    // raced into touching another tenant's project between the check and the
    // update. Unchanged by the transaction around it — which exists only so the
    // photo and the record of who set it land together.
    const result = await tx.project.updateMany({
      where: { id: projectId, orgId: actor.orgId },
      data: { heroImageUrl: input.heroImageUrl }
    })
    // Thrown inside the transaction, which rolls it back — and there is nothing
    // to roll back, because a count of zero means nothing was written.
    if (result.count === 0) throw new ServiceError('Project not found', 'NOT_FOUND')

    const changes = diffValues(
      { heroImageUrl: image(before?.heroImageUrl) },
      { heroImageUrl: image(input.heroImageUrl) }
    )
    if (changes.length > 0) {
      await recordAudit(tx, actor, {
        action: 'project.updated',
        entityType: 'Project',
        entityId: projectId,
        entityLabel: before?.name ?? null,
        changes,
        context: { projectId, projectName: before?.name }
      })
    }
  })

  // After the write, never before it: a stored image is deleted only once the
  // row that pointed at it has stopped doing so. A no-op when the value did not
  // change, and a no-op for any URL that is not this org's own blob — a pasted
  // external link belongs to somebody else and is left alone.
  await deleteReplacedBlobs([before?.heroImageUrl], [input.heroImageUrl], actor.orgId)
}

export async function listProjects(actor: SessionActor) {
  return prisma.project.findMany({
    where: { orgId: actor.orgId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { units: true } } }
  })
}
