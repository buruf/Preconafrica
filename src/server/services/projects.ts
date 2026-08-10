import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { isSupportedCurrency, toMinor } from '@/domain/currency'
import { generateUnitNames, UnitPatternError } from '@/domain/units'
import { SIZE_SQM_PATTERN, SIZE_SQM_MESSAGE } from '@/server/services/units'

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
    defaultBedrooms: z.coerce.number().int().min(0).max(10),
    defaultSizeSqm: z.string().regex(SIZE_SQM_PATTERN, SIZE_SQM_MESSAGE),
    defaultPrice: moneyString('Price'),
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

export async function listProjects(actor: SessionActor) {
  return prisma.project.findMany({
    where: { orgId: actor.orgId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { units: true } } }
  })
}
