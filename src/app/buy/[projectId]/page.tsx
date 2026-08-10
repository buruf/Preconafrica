import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { auth } from '@/server/auth'
import { prisma } from '@/server/db'
import { getSaleForBuyer, DEFAULT_TERM_MONTHS } from '@/server/services/sales'
import { formatMinor } from '@/domain/currency'
import { Card, PageHeader } from '@/components/ui'
import { PurchaseForm } from './PurchaseForm'

/**
 * Public — no session required to view this page. It must never expose more
 * than a prospective buyer should see: the project's public facts and its
 * AVAILABLE units only. No other buyer's name, no sale data, ever.
 */
export default async function BuyPage({ params }: { params: { projectId: string } }) {
  const project = await prisma.project.findUnique({
    where: { id: params.projectId },
    select: {
      id: true,
      name: true,
      location: true,
      currency: true,
      expectedCompletion: true
    }
  })
  if (!project) notFound()

  const availableUnits = await prisma.unit.findMany({
    where: { projectId: project.id, status: 'AVAILABLE' },
    orderBy: [{ floor: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, floor: true, bedrooms: true, sizeSqm: true, priceMinor: true }
  })

  const session = await auth()

  // Staff have no business in the buyer registration flow, and leaving them in
  // it was actively destructive: submitting this form registers a brand new
  // buyer and signs the browser into that account, silently replacing the
  // admin's or agent's own session. Staff create sales from the staff side.
  const role = session?.user?.role
  if (role === 'ADMIN' || role === 'AGENT') redirect('/projects')

  const isSignedInBuyer = role === 'BUYER'

  let existingSaleId: string | null = null
  if (isSignedInBuyer && session?.user?.buyerId) {
    const sale = await getSaleForBuyer({
      userId: session.user.id,
      orgId: session.user.orgId,
      role: 'BUYER',
      buyerId: session.user.buyerId,
      fullName: session.user.name ?? '',
      email: session.user.email ?? ''
    })
    existingSaleId = sale?.id ?? null
  }

  return (
    <main className="mx-auto max-w-xl p-4 sm:p-6">
      <PageHeader
        title={project.name}
        subtitle={`${project.location} · Expected completion ${project.expectedCompletion
          .toISOString()
          .slice(0, 10)}`}
      />

      {existingSaleId ? (
        <Card>
          <p className="text-sm text-slate-700">
            You already have a purchase with us.{' '}
            <Link href="/dashboard" className="font-medium underline">
              Go to your dashboard
            </Link>
            .
          </p>
        </Card>
      ) : (
        <PurchaseForm
          projectId={project.id}
          signedInAsName={isSignedInBuyer ? session?.user?.name ?? 'you' : null}
          units={availableUnits.map((unit) => ({
            id: unit.id,
            name: unit.name,
            floor: unit.floor,
            bedrooms: unit.bedrooms,
            sizeSqm: unit.sizeSqm.toString(),
            // BigInt never crosses the RSC boundary — formatted here on the server.
            priceLabel: formatMinor(unit.priceMinor, project.currency)
          }))}
          defaultTermMonths={DEFAULT_TERM_MONTHS}
        />
      )}
    </main>
  )
}
