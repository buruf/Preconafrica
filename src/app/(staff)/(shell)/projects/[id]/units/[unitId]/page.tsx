import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireStaff } from '@/server/session'
import { getProjectInventory } from '@/server/services/units'
import { ServiceError } from '@/server/services/errors'
import { formatMinor, toMajorString } from '@/domain/currency'
import { installmentFeeSummary } from '@/domain/schedule'
import { projectFeeConfig } from '@/server/services/sales'
import { ButtonLink, Card, MoneyPair, PageHeader, StatusPill } from '@/components/ui'
import { indicativeUsdLine } from '@/components/indicative-usd'
import { UnitImagery } from '@/components/media'
import { UnitEditForm } from './UnitEditForm'

/**
 * One unit, in full.
 *
 * This screen exists because the inventory became a grid of tiles. A tile has
 * room for a name and a bed count and nothing else, so the four things an
 * inventory row used to carry — the price, the Sell link, the sale link for a
 * sold unit, and the admin's edit form — needed somewhere to live that was not
 * inside a 98px square. The mockup already had the answer: a Unit Details
 * screen with the photo, the specs, the price and the action.
 *
 * Everything the row could do is here, and it can now show what a row never had
 * space for: the floor plan and the renders at a size a buyer can actually look
 * at while deciding.
 *
 * A server component behind `requireStaff`, like every other page in this app —
 * the middleware protects nothing, so this guard is the boundary.
 */
export default async function UnitPage({
  params
}: {
  params: { id: string; unitId: string }
}) {
  const actor = await requireStaff()

  // Read through the inventory service rather than a new per-unit query: it is
  // already org-scoped (a project from another organisation comes back
  // NOT_FOUND rather than leaking), it already carries the sale id, the layout
  // and the renders, and this stage is presentation only — a screen wanting the
  // same rows in a different shape is not a reason to add a service function.
  let inventory
  try {
    inventory = await getProjectInventory(actor, params.id)
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'NOT_FOUND') notFound()
    throw error
  }
  const { project } = inventory

  // A unitId that belongs to another project — or to nothing — is a 404, for the
  // same reason a cross-org project is: the URL names something this actor
  // cannot see, and "which of the two is it" is not information to give away.
  const unit = inventory.floors.flatMap((floor) => floor.units).find((u) => u.id === params.unitId)
  if (!unit) notFound()

  const money = (amount: bigint) => formatMinor(amount, project.currency)
  const indicativeUsd = indicativeUsdLine(unit.priceMinor, project.currency)

  return (
    <>
      {/* The way back. A bottom tab bar has no back button, and Projects lands
          on the project list rather than on the floor plate this unit came
          from. */}
      <Link
        href={`/projects/${project.id}`}
        className="mb-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-navy-900"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 19l-7-7 7-7" />
        </svg>
        {project.name}
      </Link>

      <PageHeader
        title={`Unit ${unit.name}`}
        subtitle={`Floor ${unit.floor} · ${project.location}`}
        action={<StatusPill status={unit.status} />}
      />

      {/* What the buyer came to look at, at the size the sale page and the
          confirm step show it — one arrangement everywhere, so what a buyer sees
          while deciding is exactly what they see afterwards. */}
      <Card className="mb-4">
        <UnitImagery
          unitName={unit.name}
          projectName={project.name}
          layoutImageUrl={unit.layoutImageUrl}
          renderImageUrls={unit.renderImageUrls}
        />
      </Card>

      <Card className="mb-4">
        <div className="divide-y divide-line">
          {/* The price, and under it the mockup's rough dollar equivalent. The
              second line is presentation and nothing else — see
              `@/components/indicative-usd`, which no money path may import — so
              it is drawn here rather than folded into `MoneyPair`, and it simply
              is not there for a currency with no rate. */}
          <div className="pb-2.5">
            <MoneyPair label="Price" value={money(unit.priceMinor)} />
            {indicativeUsd ? (
              <p className="mt-0.5 text-right text-[13px] tabular-nums text-muted">
                {indicativeUsd}
              </p>
            ) : null}
          </div>
          <MoneyPair className="py-2.5" label="Bedrooms" value={String(unit.bedrooms)} />
          <MoneyPair className="py-2.5" label="Size" value={`${unit.sizeSqm} m²`} />
          {/* The charge a "Sell" from here will prefill, quoted the same way the
              inventory header quotes it: '10%' or the money, and never a
              percentage for a flat fee. */}
          <MoneyPair
            className="pt-2.5"
            label="Installment charge"
            value={installmentFeeSummary(projectFeeConfig(project), project.currency)}
          />
        </div>
      </Card>

      {/* The entry point to the whole staff sale flow, and the route to an
          existing contract. Both staff roles get Sell — an agent selling units is
          the job description, and `createSale` authorizes the write itself. A
          RESERVED unit with no sale yet offers neither, exactly as the old row
          did. */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        {unit.status === 'AVAILABLE' ? (
          <ButtonLink
            href={`/projects/${project.id}/sell/${unit.id}`}
            className="w-full sm:w-auto"
          >
            Sell this unit
          </ButtonLink>
        ) : null}

        {unit.saleId ? (
          <ButtonLink
            href={`/sales/${unit.saleId}`}
            variant="secondary"
            className="w-full sm:w-auto"
          >
            View sale
          </ButtonLink>
        ) : null}
      </div>

      {/* ADMIN only at the door as well as in the service. An admin can still
          reprice a sold unit — repricing affects new sales only, since a signed
          Sale holds its own snapshot. */}
      {actor.role === 'ADMIN' ? (
        <UnitEditForm
          projectId={project.id}
          unit={{
            id: unit.id,
            name: unit.name,
            bedrooms: unit.bedrooms,
            sizeSqm: unit.sizeSqm,
            // Plain strings, so they cross the RSC boundary as-is.
            layoutImageUrl: unit.layoutImageUrl,
            renderImageUrls: unit.renderImageUrls,
            // Exponent-aware and lossless: plain integer division would truncate
            // the fractional part (₦1,000.50 -> "1000") and resubmitting the form
            // unchanged would silently reprice the unit. No bigint crosses into
            // the client component.
            priceInput: toMajorString(unit.priceMinor, project.currency)
          }}
        />
      ) : null}
    </>
  )
}
