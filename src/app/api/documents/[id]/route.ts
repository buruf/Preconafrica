import { NextResponse } from 'next/server'
import { prisma } from '@/server/db'
import { renderDocumentPdf } from '@/server/pdf/render'
import { requireUserOrNull } from '@/server/session'

export const runtime = 'nodejs'

// PDF rendering (@react-pdf/renderer) is the slowest operation in this app —
// a 36-installment statement lays out and paginates dozens of table rows —
// and there was no `maxDuration` anywhere in the app before this route, so it
// was inheriting whatever the platform's unconfigured default is. Measured
// directly against `renderDocumentPdf` (see the task report), even the
// largest seeded statement renders in well under a second — 15s is not
// "how long this needs", it is "enough headroom for a slow buyer connection
// and a cold serverless start to not falsely time out", while still being
// low enough that a genuine regression (an infinite loop, a runaway query)
// fails fast instead of hanging for minutes.
export const maxDuration = 15

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  // Not `auth()`. This route hands out contracts, invoices and receipts, so it
  // authenticates exactly as every page does — `requireUserOrNull` runs the
  // same deactivation and password-change checks against the database, and
  // returns null instead of redirecting, because a 307 to /login is not a
  // useful answer to a fetch for a PDF.
  const actor = await requireUserOrNull()
  if (!actor) return new NextResponse('Unauthorized', { status: 401 })

  // Buyers may only fetch documents attached to their own sale. Scoped by the
  // session's buyerId, so a guessed document id returns 404, not a leak — and
  // never a 403, which would confirm to a guesser that the id exists at all.
  const where =
    actor.role === 'BUYER'
      ? { id: params.id, orgId: actor.orgId, sale: { buyerId: actor.buyerId ?? '' } }
      : { id: params.id, orgId: actor.orgId }

  const allowed = await prisma.document.findFirst({ where, select: { id: true } })
  if (!allowed) return new NextResponse('Not found', { status: 404 })

  const { buffer, filename } = await renderDocumentPdf(params.id, actor.orgId)

  // `Buffer` is a `Uint8Array` at runtime, but @types/node's generic
  // `Buffer<ArrayBufferLike>` does not structurally match lib.dom's
  // `BodyInit` — wrapping in a plain `Uint8Array` view (no copy) satisfies
  // the type without changing what actually goes over the wire.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, max-age=300'
    }
  })
}
