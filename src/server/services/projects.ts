import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { isSupportedCurrency, toMinor } from '@/domain/currency'
import { generateUnitNames, UnitPatternError } from '@/domain/units'
import { percentToBps } from '@/domain/schedule'
import { SIZE_SQM_PATTERN, SIZE_SQM_MESSAGE } from '@/server/services/units'
import { ImageUrlField } from '@/server/services/media'

const MAX_UNITS = 2000

/** Validates that a major-unit string is parseable in the chosen currency. */
function moneyString(field: string) {
  return z.string().min(1, `${field} is required`)
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
    defaultBedrooms: z.coerce.number().int().min(0).max(10),
    defaultSizeSqm: z.string().regex(SIZE_SQM_PATTERN, SIZE_SQM_MESSAGE),
    defaultPrice: moneyString('Price'),
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

    // Currency-aware price validation: '100.50' is valid NGN but invalid RWF.
    try {
      toMinor(value.defaultPrice, value.currency)
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultPrice'],
        message: error instanceof Error ? error.message : 'Invalid price'
      })
    }

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

  const priceMinor = toMinor(input.defaultPrice, input.currency)

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
      data: drafts.map((draft) => ({
        projectId: created.id,
        name: draft.name,
        floor: draft.floor,
        bedrooms: input.defaultBedrooms,
        sizeSqm: input.defaultSizeSqm,
        priceMinor
      }))
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

  // Org-scoped, and scoped in the write itself rather than by a read-then-write:
  // `updateMany` with the orgId in the predicate cannot be raced into touching
  // another tenant's project between the check and the update.
  const result = await prisma.project.updateMany({
    where: { id: projectId, orgId: actor.orgId },
    data: { heroImageUrl: input.heroImageUrl }
  })
  if (result.count === 0) throw new ServiceError('Project not found', 'NOT_FOUND')
}

export async function listProjects(actor: SessionActor) {
  return prisma.project.findMany({
    where: { orgId: actor.orgId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { units: true } } }
  })
}
