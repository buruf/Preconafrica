import { NextResponse } from 'next/server'
import { prisma } from '@/server/db'
import { renderFloorPlanPdf } from '@/server/pdf/floor-plan'
import { requireUserOrNull } from '@/server/session'

export const runtime = 'nodejs'

/**
 * Matched to the documents route rather than picked afresh: this renders one
 * A4 page with at most one embedded image, so it is strictly less work than a
 * 36-installment statement. 15s is headroom for a cold serverless start plus a
 * slow fetch of the drawing, not an estimate of the work.
 */
export const maxDuration = 15

/**
 * The unit's floor plan, as a PDF, generated on demand.
 *
 * **Why there is no `Document` row behind this.** The other three documents are
 * financial records: each carries an org-sequential number, each persists, and
 * `Document.saleId` is required. A floor plan is a derived view of the unit's
 * own data and is wanted *before* a sale exists — an agent showing a walk-in
 * buyer — so hanging it off a sale would be wrong, and giving it a number would
 * imply a transaction that has not happened. Nothing is written; the bytes come
 * from the unit every time.
 *
 * **Access.** Deliberately two different scopes, both expressed as the `where`
 * of a single read so that a refusal is indistinguishable from a miss:
 *
 *  - Staff (ADMIN/AGENT) may fetch any unit in their own organisation. `Unit`
 *    has no `orgId` of its own, so the scope goes through the project.
 *  - A BUYER may fetch only the unit that is the subject of *their own* sale.
 *    Org scoping alone would not do: every buyer in a developer's organisation
 *    shares its `orgId`, so `project.orgId` would let any of them read any
 *    other's unit. `Sale.unitId` is `@unique`, so `sale.buyerId` names exactly
 *    one buyer per unit.
 *
 * Everything else — another org's unit, another buyer's unit, an id that never
 * existed — is 404 and never 403, because a 403 confirms the id is real.
 */
export async function GET(_request: Request, { params }: { params: { unitId: string } }) {
  // `requireUserOrNull`, not `auth()` and not `requireUser()`: the same
  // deactivation and password-change revocation checks every page runs, but
  // returning null instead of redirecting, because a 307 to /login is not a
  // useful answer to a fetch for a PDF. Identical to the documents route.
  const actor = await requireUserOrNull()
  if (!actor) return new NextResponse('Unauthorized', { status: 401 })

  const where =
    actor.role === 'BUYER'
      ? {
          id: params.unitId,
          project: { orgId: actor.orgId },
          // `?? ''` matches the documents route: a BUYER session with no
          // buyerId is a broken session, and it must match nothing rather than
          // fall through to an unscoped read.
          sale: { buyerId: actor.buyerId ?? '' }
        }
      : { id: params.unitId, project: { orgId: actor.orgId } }

  const allowed = await prisma.unit.findFirst({ where, select: { id: true } })
  if (!allowed) return new NextResponse('Not found', { status: 404 })

  const { buffer, filename } = await renderFloorPlanPdf(params.unitId, actor.orgId)

  // `Buffer` is a `Uint8Array` at runtime, but @types/node's generic
  // `Buffer<ArrayBufferLike>` does not structurally match lib.dom's `BodyInit` —
  // wrapping in a plain `Uint8Array` view (no copy) satisfies the type without
  // changing what goes over the wire.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      // Private and short-lived, like the documents route: a plan is not public,
      // and a replaced drawing should reach a buyer within minutes.
      'Cache-Control': 'private, max-age=300'
    }
  })
}
