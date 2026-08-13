import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { arrearsReport } from '@/server/services/arrears'
import { getOrganizationName } from '@/server/services/team'

/**
 * What the staff home screen needs, assembled in the service layer rather than
 * in the page.
 *
 * There is no new *rule* here — every figure is a count or a minimum of rows
 * that already exist, and the one derived number (buyers overdue) comes from
 * `arrearsReport`, which already owns what "overdue" means. This module exists
 * so the page can be four `map`s over a plain object instead of five queries
 * and a reduce.
 */

export interface StaffProjectCard {
  id: string
  name: string
  location: string
  currency: string
  heroImageUrl: string | null
  unitsTotal: number
  unitsAvailable: number
  /**
   * The cheapest *available* unit, or null when nothing is left to sell —
   * which is what a "from" price means to a buyer. Minor units: the page
   * formats it with `formatMinor` before anything renders it, and it never
   * crosses into a client component.
   */
  fromPriceMinor: bigint | null
}

export interface StaffHome {
  organizationName: string
  projects: StaffProjectCard[]
  /** Across the whole organisation, not per project. */
  unitsAvailable: number
  salesActive: number
  buyersOverdue: number
}

export async function staffHome(actor: SessionActor, asOf: Date): Promise<StaffHome> {
  // The same roles `arrearsReport` and `listProjects` serve. Asserted up front
  // so the failure is one clean AuthorizationError rather than whichever of the
  // parallel queries below happens to reject first.
  assertRole(actor, ['ADMIN', 'AGENT'])

  const [organizationName, projects, availability, salesActive, arrears] = await Promise.all([
    getOrganizationName(actor),
    prisma.project.findMany({
      where: { orgId: actor.orgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        location: true,
        currency: true,
        heroImageUrl: true,
        _count: { select: { units: true } }
      }
    }),
    // One grouped query for both the availability count and the "from" price,
    // rather than loading every unit row of every project to count them in JS —
    // a project may hold 2,000 units and this is the first screen after login.
    prisma.unit.groupBy({
      by: ['projectId'],
      where: { project: { orgId: actor.orgId }, status: 'AVAILABLE' },
      _count: { _all: true },
      _min: { priceMinor: true }
    }),
    prisma.sale.count({ where: { orgId: actor.orgId, status: 'ACTIVE' } }),
    arrearsReport(actor, asOf)
  ])

  const byProject = new Map(availability.map((row) => [row.projectId, row]))

  return {
    organizationName,
    projects: projects.map((project) => {
      const available = byProject.get(project.id)
      return {
        id: project.id,
        name: project.name,
        location: project.location,
        currency: project.currency,
        heroImageUrl: project.heroImageUrl,
        unitsTotal: project._count.units,
        unitsAvailable: available?._count._all ?? 0,
        fromPriceMinor: available?._min.priceMinor ?? null
      }
    }),
    unitsAvailable: availability.reduce((sum, row) => sum + row._count._all, 0),
    salesActive,
    // One row per overdue sale, and a sale has one buyer — so the row count is
    // the number of buyers in arrears.
    buyersOverdue: arrears.length
  }
}
