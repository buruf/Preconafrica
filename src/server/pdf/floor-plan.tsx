import { renderToBuffer } from '@react-pdf/renderer'
import { prisma } from '@/server/db'
import { ServiceError } from '@/server/services/errors'
import { FloorPlanDocument } from '@/server/pdf/FloorPlanDocument'
import { fetchGuardedImages, toPdfImage } from '@/server/media/images'
import { floorPlanFilename } from '@/domain/units'

/**
 * Renders one unit's floor plan on demand.
 *
 * Nothing is stored. Unlike `renderDocumentPdf`, there is no `Document` row
 * behind this and no number to quote: an invoice, a receipt and a statement are
 * financial records tied to a sale, while a floor plan is a derived view of the
 * unit's own data that an agent wants *before* any sale exists. See
 * `FloorPlanDocument` for the rest of that reasoning, including why no price
 * appears on the page.
 *
 * Org scoping is repeated here rather than trusted from the caller. The route
 * has already decided the actor may see this unit — including the buyer-scoped
 * case, which is narrower than anything this function can express — but a read
 * that could return another organisation's unit if a caller forgot an argument
 * is not a read this codebase should contain.
 */
export async function renderFloorPlanPdf(
  unitId: string,
  orgId: string
): Promise<{ buffer: Buffer; filename: string }> {
  const unit = await prisma.unit.findFirst({
    where: { id: unitId, project: { orgId } },
    include: {
      project: {
        select: {
          name: true,
          location: true,
          expectedCompletion: true,
          org: { select: { name: true, logoUrl: true } }
        }
      }
    }
  })
  if (!unit) throw new ServiceError('Unit not found', 'NOT_FOUND')

  // Both images fetched once, concurrently, before any rendering starts — the
  // same rule the other documents follow. @react-pdf's render is synchronous
  // and a URL handed straight to `Image` would reach out to the network from
  // inside it, bypassing the SSRF guard entirely. A null URL short-circuits
  // before any request, so a unit with no plan costs nothing.
  //
  // `toPdfImage` then applies MAX_PDF_IMAGE_BYTES and the PNG/JPEG-only rule.
  // Anything it rejects becomes null, which the document renders as its empty
  // panel: a 2MB architectural scan must not turn a 12 kB document a buyer
  // downloads on mobile data into a 2MB one.
  const fetched = await fetchGuardedImages({
    logo: unit.project.org.logoUrl,
    plan: unit.layoutImageUrl
  })

  return {
    filename: floorPlanFilename(unit.name),
    buffer: await renderToBuffer(
      <FloorPlanDocument
        orgName={unit.project.org.name}
        projectName={unit.project.name}
        projectLocation={unit.project.location}
        expectedCompletion={unit.project.expectedCompletion}
        unitName={unit.name}
        floor={unit.floor}
        bedrooms={unit.bedrooms}
        // `Decimal` -> string on the server, so nothing but a string reaches the
        // document — the same rule that keeps bigint out of client components.
        sizeSqm={unit.sizeSqm.toString()}
        logo={toPdfImage(fetched.logo)}
        plan={toPdfImage(fetched.plan)}
      />
    )
  }
}
