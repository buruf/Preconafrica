import { NextResponse } from 'next/server'
import { requireStaff } from '@/server/session'
import { arrearsReport } from '@/server/services/arrears'
import {
  ARREARS_CSV_HEADERS,
  arrearsCsvFilename,
  arrearsCsvTable
} from '@/server/services/arrears-export'
import { CSV_BOM, toCsv } from '@/server/csv'

export const runtime = 'nodejs'

/**
 * The arrears report as a spreadsheet.
 *
 * `requireStaff()` like every page, not because a layout or the middleware would
 * otherwise cover it — the middleware protects nothing here by design — but
 * because this file hands out every overdue buyer's name, phone number, email
 * address and outstanding balance in one download. It is the single most
 * sensitive response in the app, and `arrearsReport` re-authorizes and
 * re-scopes to the actor's organisation on top of this.
 *
 * The `project` query parameter is the same one the report screen uses, so the
 * download from a filtered screen is the filtered list: a URL that is shared and
 * a file that is exported cannot disagree about what they cover.
 */
export async function GET(request: Request) {
  const actor = await requireStaff()

  // Trusted for nothing except narrowing: `arrearsReport` keeps `orgId` in the
  // predicate, so an id from another organisation matches no rows rather than
  // leaking any. An absent or empty value means every project.
  const projectId = new URL(request.url).searchParams.get('project') ?? undefined

  // One instant for the filename and for every "is this overdue" decision
  // inside the report, so the file cannot be dated a second after the rows it
  // contains were derived.
  const asOf = new Date()
  const rows = await arrearsReport(actor, asOf, { projectId })

  const body = CSV_BOM + toCsv([[...ARREARS_CSV_HEADERS], ...arrearsCsvTable(rows)])

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      // `attachment`, so it lands in the downloads folder rather than rendering
      // as a wall of text in the tab the agent was using.
      'Content-Disposition': `attachment; filename="${arrearsCsvFilename(asOf)}"`,
      // Never cached, anywhere. It is a snapshot of who owes money right now,
      // and it is scoped to one organisation — a shared cache entry would be
      // both stale and a cross-tenant leak.
      'Cache-Control': 'private, no-store'
    }
  })
}
