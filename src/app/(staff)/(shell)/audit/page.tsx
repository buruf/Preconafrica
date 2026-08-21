import Link from 'next/link'
import { requireAdmin } from '@/server/session'
import {
  AUDIT_ENTITY_TYPES,
  AUDIT_PAGE_SIZE,
  listAuditEntries,
  type AuditPage
} from '@/server/services/audit'
import { describeAuditEntry } from '@/domain/audit'
import { Button, ButtonLink, Card, Field, PageHeader, Select } from '@/components/ui'

/**
 * The organisation's history, newest first.
 *
 * ## Why it is a page on Profile and not a fifth tab
 *
 * DESIGN.md's navigation section caps the bar at four destinations for staff
 * and three for a buyer, and says what a role sees is decided by the role
 * rather than the user. An admin-only fifth tab would make an admin's bar a
 * different shape from an agent's on the same screens — the exact thing that
 * rule exists to prevent — and the audit log is an occasional administrative
 * surface, not a daily destination. So it sits beside Team on Profile, which is
 * already "you and your organisation", and Profile's `owns` list keeps that tab
 * lit while you are here.
 *
 * ## Why every filter is a search param
 *
 * The whole screen is server-rendered with no client component on it: the
 * filters are a plain GET form, the pagination is plain links. That makes any
 * view of the log a URL — "every price change in August, by Tunde" is something
 * an owner can send to their accountant, and it survives a reload. It also
 * means the money on this page is formatted by `formatMinor` on the server and
 * no `bigint` has anywhere to cross to.
 *
 * ## Why a sentence rather than a table
 *
 * The reader is a property developer, not a DBA. `describeAuditEntry` turns an
 * entry into one line of English built entirely out of what was true at the
 * time — so a unit renamed since is still named as it was when it happened.
 *
 * ## Volume
 *
 * A busy developer — a few hundred payments a month, each with its receipt, a
 * few hundred invoices, forty sales, a scattering of edits — writes on the
 * order of a thousand to fifteen hundred entries a month. `@@index([orgId,
 * createdAt])` serves the tenant scope, the ordering and the date range from
 * one scan; at that volume the entity and actor filters ride on top of an
 * already tight range and do not yet earn indexes of their own. See the schema
 * for when they would.
 */

/** Times are UTC, said once at the top of the page rather than per row. */
const TIMESTAMP = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC'
})

/** "14 Aug 2026, 09:12". */
function formatTimestamp(at: Date): string {
  return TIMESTAMP.format(at)
}

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/**
 * The current filters as a query string, with `page` replaced.
 *
 * Built from what the service reported it actually applied, not from the raw
 * query — so a junk `entityType=DROP TABLE` in a shared link is dropped from
 * the pagination links rather than carried along.
 */
function pageHref(applied: AuditPage['applied'], page: number): string {
  const query = new URLSearchParams()
  if (applied.entityType) query.set('entityType', applied.entityType)
  if (applied.actorUserId) query.set('actor', applied.actorUserId)
  if (applied.from) query.set('from', applied.from)
  if (applied.to) query.set('to', applied.to)
  if (page > 1) query.set('page', String(page))
  const suffix = query.toString()
  return suffix ? `/audit?${suffix}` : '/audit'
}

export default async function AuditPage({
  searchParams
}: {
  searchParams?: {
    entityType?: string | string[]
    actor?: string | string[]
    from?: string | string[]
    to?: string | string[]
    page?: string | string[]
  }
}) {
  // ADMIN only, and this is the guard — the (staff) layout admits agents too.
  // An AGENT reaching this URL gets AuthorizationError into the staff error
  // boundary, exactly as /team does.
  const actor = await requireAdmin()

  const requestedPage = Number.parseInt(firstParam(searchParams?.page), 10)

  const result = await listAuditEntries(actor, {
    entityType: firstParam(searchParams?.entityType),
    actorUserId: firstParam(searchParams?.actor),
    from: firstParam(searchParams?.from),
    to: firstParam(searchParams?.to),
    page: Number.isNaN(requestedPage) ? 1 : requestedPage
  })

  const { applied, entries, page, pageCount, total } = result
  const filtered = Boolean(applied.entityType || applied.actorUserId || applied.from || applied.to)
  const firstOnPage = total === 0 ? 0 : (page - 1) * AUDIT_PAGE_SIZE + 1
  const lastOnPage = Math.min(page * AUDIT_PAGE_SIZE, total)

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle={
          total === 0
            ? 'Every change to money, inventory and access. Times are UTC.'
            : `Showing ${firstOnPage}–${lastOnPage} of ${total} ${
                total === 1 ? 'entry' : 'entries'
              }. Times are UTC.`
        }
      />

      {/* A GET form, so a filtered view is a URL somebody can send. Native
          controls throughout: no JavaScript on this screen at all. `page` is
          deliberately absent — changing a filter returns you to page 1, because
          page 9 of the old filter is not page 9 of the new one. */}
      <Card className="mb-5">
        <form method="get" className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="What" name="entityType">
              <Select name="entityType" defaultValue={applied.entityType}>
                <option value="">Everything</option>
                {AUDIT_ENTITY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ENTITY_LABEL[type]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Who" name="actor">
              <Select name="actor" defaultValue={applied.actorUserId}>
                <option value="">Anyone</option>
                {result.actors.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.fullName}
                    {candidate.active ? '' : ' (deactivated)'}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="From" name="from" type="date" defaultValue={applied.from} />
            <Field label="To" name="to" type="date" defaultValue={applied.to} />
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button type="submit" variant="secondary" className="w-full sm:w-auto">
              Apply filters
            </Button>
            {filtered ? (
              <ButtonLink href="/audit" variant="secondary" className="w-full sm:w-auto">
                Clear
              </ButtonLink>
            ) : null}
          </div>
        </form>
      </Card>

      {entries.length === 0 ? (
        <Card>
          <p className="text-[15px] text-muted">
            {filtered
              ? 'Nothing matches those filters.'
              : 'Nothing has been recorded yet. Every sale, payment, price change and access change from here on will appear on this page.'}
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => {
            const { sentence, href } = describeAuditEntry(entry)
            return (
              <li key={entry.id}>
                <Card>
                  {/* min-w-0 + break-words: a long sentence wraps rather than
                      pushing the card wider than a 375px screen. */}
                  <div className="min-w-0">
                    <p className="break-words text-[15px] text-ink">{sentence}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[13px] tabular-nums text-muted">
                        {formatTimestamp(entry.createdAt)}
                      </span>
                      <span className="text-[13px] text-muted">
                        {ROLE_LABEL[entry.actorRole] ?? entry.actorRole}
                      </span>
                      {href ? (
                        // 44px, because it is the one thing on the row anybody
                        // taps, on a phone, from a list.
                        <Link
                          href={href}
                          className="inline-flex min-h-11 items-center text-[13px] font-semibold text-navy-900 underline"
                        >
                          {LINK_LABEL[entry.entityType] ?? 'Open'}
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      {pageCount > 1 ? (
        <nav
          aria-label="Audit log pages"
          className="mt-5 flex flex-wrap items-center justify-between gap-3"
        >
          {page > 1 ? (
            <ButtonLink href={pageHref(applied, page - 1)} variant="secondary">
              Newer
            </ButtonLink>
          ) : (
            <span />
          )}
          <span className="text-[13px] tabular-nums text-muted">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <ButtonLink href={pageHref(applied, page + 1)} variant="secondary">
              Older
            </ButtonLink>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </>
  )
}

/**
 * What each entity type is called on screen. The model names are the log's
 * vocabulary, not the reader's — a developer looking for a price change is
 * looking for "Units", not for `Unit`.
 */
const ENTITY_LABEL: Record<string, string> = {
  Sale: 'Sales',
  Payment: 'Payments',
  Unit: 'Units',
  Project: 'Projects',
  Document: 'Documents',
  User: 'People',
  Organization: 'Organisation'
}

/**
 * What the row's link says, which is the *destination*, not the entity.
 *
 * A payment and a receipt have no page of their own, so both link to the sale
 * they belong to — and the link says "Open sale", because a link that says
 * "Open payment" and lands on a sale is a link that lies. Keep this in step
 * with `auditEntryHref`.
 */
const LINK_LABEL: Record<string, string> = {
  Sale: 'Open sale',
  Payment: 'Open sale',
  Document: 'Open sale',
  Unit: 'Open unit',
  Project: 'Open project',
  User: 'Open team',
  Organization: 'Open team'
}

/** Matches the Profile page's wording, so one role has one name in this app. */
const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrator',
  AGENT: 'Sales agent',
  BUYER: 'Buyer',
  // Not one of this organisation's roles, and the label says so plainly: it
  // marks the two entries nobody here wrote — being suspended, and having the
  // suspension lifted. Without it the badge rendered the raw 'PLATFORM'.
  PLATFORM: 'PreCon Africa'
}
