import type { Prisma } from '@prisma/client'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import type { AuditChange, AuditContext, AuditEntryView } from '@/domain/audit'

/**
 * The read side of the audit log — everything `/audit` needs, and nothing that
 * would let a page reach past it.
 *
 * Writes live in @/server/audit/record.ts and are called from the services that
 * make the change. This module never writes.
 */

/** How many rows a page shows. */
export const AUDIT_PAGE_SIZE = 25

/**
 * The entity types the filter offers, in the order they appear.
 *
 * A fixed list rather than a `SELECT DISTINCT entityType`: the second gets
 * slower exactly as the table gets bigger, and it would silently drop an option
 * from the filter on the day an organisation happens to have no entries of that
 * kind yet — which is the day it is least obvious that the filter is complete.
 */
export const AUDIT_ENTITY_TYPES = [
  'Sale',
  'Payment',
  'Unit',
  'Project',
  'Document',
  'User',
  'Organization'
] as const

export type AuditEntityTypeFilter = (typeof AUDIT_ENTITY_TYPES)[number]

export interface AuditFilters {
  entityType?: string
  actorUserId?: string
  /** Inclusive, as a yyyy-mm-dd string from the query. */
  from?: string
  /** Inclusive of the whole day — see `endOfDay` below. */
  to?: string
  page?: number
}

export interface AuditActorOption {
  id: string
  fullName: string
  role: string
  active: boolean
}

export interface AuditPage {
  entries: AuditEntryView[]
  /** 1-based. Clamped into range, so a hand-typed `?page=900` lands on the last. */
  page: number
  pageCount: number
  total: number
  /** Everyone who could appear in the log, for the actor filter. */
  actors: AuditActorOption[]
  /** The filters as they were actually applied, for the form and the links. */
  applied: {
    entityType: string
    actorUserId: string
    from: string
    to: string
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A yyyy-mm-dd string as a Date, or null for anything that is not one. */
function startOfDay(value: string | undefined): Date | null {
  if (!value || !ISO_DATE.test(value)) return null
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * The *end* of the named day, so `to=2026-08-14` includes everything that
 * happened on the 14th. Taking the start of the day would silently exclude a
 * whole day's entries from a range whose upper bound the user named — the
 * classic off-by-one that makes a date filter untrustworthy.
 */
function endOfDay(value: string | undefined): Date | null {
  if (!value || !ISO_DATE.test(value)) return null
  const parsed = new Date(`${value}T23:59:59.999Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * The Json columns, back into the shapes the renderer expects.
 *
 * Defensive rather than a bare cast: these columns are `Json`, so nothing in
 * the type system stops a hand-written row (or a older/newer schema version)
 * from holding something else. A malformed `changes` degrades to no changes and
 * the sentence still renders — a page of history must not 500 because one row
 * from 2027 has a shape this build has never seen.
 */
function parseChanges(value: Prisma.JsonValue): AuditChange[] {
  if (!Array.isArray(value)) return []
  const usable = value.filter(
    (item) =>
      typeof item === 'object' && item !== null && 'field' in item && 'from' in item && 'to' in item
  )
  // The cast is after the shape check, not instead of it. `Prisma.JsonValue`
  // has no index signature to narrow through, so a type predicate cannot be
  // written here — the filter above is the check, and this is what tells the
  // compiler it ran.
  return usable as unknown as AuditChange[]
}

function parseContext(value: Prisma.JsonValue): AuditContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as AuditContext
}

/**
 * One page of the organisation's history, newest first.
 *
 * ADMIN only, and org-scoped in the query itself — `actor.orgId` is a
 * predicate on every read here, never a filter applied afterwards, so there is
 * no code path on which another tenant's entries could be counted, paginated
 * over, or rendered.
 */
export async function listAuditEntries(
  actor: SessionActor,
  filters: AuditFilters
): Promise<AuditPage> {
  assertRole(actor, ['ADMIN'])

  const entityType = (AUDIT_ENTITY_TYPES as readonly string[]).includes(filters.entityType ?? '')
    ? (filters.entityType as string)
    : ''
  const from = startOfDay(filters.from)
  const to = endOfDay(filters.to)

  // The actor filter is validated against the organisation's own users rather
  // than trusted from the query string. An id from another tenant would match
  // nothing anyway (orgId is already a predicate), but validating it here means
  // the form redraws with a blank selection instead of silently showing an
  // empty log for an id nobody recognises.
  const actors = await listAuditActors(actor)
  const actorUserId = actors.some((candidate) => candidate.id === filters.actorUserId)
    ? (filters.actorUserId as string)
    : ''

  const where: Prisma.AuditEntryWhereInput = {
    orgId: actor.orgId,
    ...(entityType ? { entityType } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {})
  }

  const total = await prisma.auditEntry.count({ where })
  const pageCount = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE))
  // Clamped rather than refused: a stale link to page 40 of a filter that now
  // has three pages should show the last page, not an error.
  const page = Math.min(Math.max(1, Math.trunc(filters.page ?? 1)), pageCount)

  const rows = await prisma.auditEntry.findMany({
    where,
    // `id` breaks the tie. Two entries written inside one transaction can share
    // a `createdAt` to the millisecond, and without a second key their relative
    // order would be whatever the planner felt like — so the same page, loaded
    // twice, could show them in different orders or repeat one across a page
    // boundary. cuids are monotonic enough within a process for this, and are
    // in any case stable, which is the property paging actually needs.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * AUDIT_PAGE_SIZE,
    take: AUDIT_PAGE_SIZE
  })

  return {
    entries: rows.map((row) => ({
      id: row.id,
      actorName: row.actorName,
      actorRole: row.actorRole,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      entityLabel: row.entityLabel,
      changes: parseChanges(row.changes),
      context: parseContext(row.context),
      createdAt: row.createdAt
    })),
    page,
    pageCount,
    total,
    actors,
    applied: { entityType, actorUserId, from: filters.from ?? '', to: filters.to ?? '' }
  }
}

/**
 * Everyone in the organisation who could appear in the log.
 *
 * Read from `User` rather than by grouping the audit table: the user list is a
 * few dozen rows and never grows with history, while a `GROUP BY actorUserId`
 * over the largest table in the database would get slower every month for a
 * dropdown. It also includes people who have not acted yet and people who have
 * been deactivated since — both of whom belong in a filter over the past.
 */
export async function listAuditActors(actor: SessionActor): Promise<AuditActorOption[]> {
  assertRole(actor, ['ADMIN'])
  const users = await prisma.user.findMany({
    where: { orgId: actor.orgId },
    orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
    select: { id: true, fullName: true, role: true, disabledAt: true }
  })
  return users.map((user) => ({
    id: user.id,
    fullName: user.fullName,
    role: user.role,
    active: user.disabledAt === null
  }))
}
