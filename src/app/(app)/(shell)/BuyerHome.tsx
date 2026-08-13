import { requireBuyer } from '@/server/session'
import { getSaleForBuyer, summariseSale } from '@/server/services/sales'
import { deriveStatus } from '@/domain/status'
import { formatMinor } from '@/domain/currency'
import { ButtonLink, Card, MoneyPair, PageHeader, ProgressBar, StatCard } from '@/components/ui'
import { MediaImage } from '@/components/media'

const isoDate = (value: Date) => value.toISOString().slice(0, 10)

/**
 * The buyer's first screen: the thing they bought, and the one number they came
 * for.
 *
 * It is deliberately not a second dashboard. Outstanding balance is the hero,
 * paid-to-date and next-due sit under it, and everything else — the schedule,
 * the payment history, the invoices — is one tap away behind "Open my
 * dashboard". A buyer checking their phone on the way to work wants to know
 * what they owe and when.
 *
 * Server-rendered, and every figure passes through `formatMinor` here: no
 * bigint crosses into a client component.
 */
export async function BuyerHome() {
  // Its own guard. Also the thing that narrows the actor to one carrying a
  // buyerId, which is what scopes the sale lookup to this buyer's own contract.
  const actor = await requireBuyer()
  const sale = await getSaleForBuyer(actor)

  if (!sale) {
    return (
      <>
        <PageHeader title={`Hello, ${actor.fullName.split(' ')[0]}`} />
        <Card>
          <p className="text-sm text-muted">
            You do not have a unit yet. Your agent will add one here once your purchase is
            recorded.
          </p>
        </Card>
      </>
    )
  }

  // One instant for the whole screen, so the paid count and the summary cannot
  // disagree about what "today" is.
  const asOf = new Date()
  const summary = summariseSale(sale, asOf)
  const money = (amount: bigint) => formatMinor(amount, sale.currency)

  const paidEntries = sale.scheduleEntries.filter(
    (entry) => deriveStatus(entry, asOf) === 'PAID'
  ).length

  return (
    <>
      <PageHeader
        title={`Unit ${sale.unit.name}`}
        subtitle={`${sale.project.name} · ${sale.project.location}`}
      />

      <div className="mb-4">
        <MediaImage
          kind="building"
          src={sale.project.heroImageUrl}
          alt={`${sale.project.name}, ${sale.project.location}`}
        />
      </div>

      <StatCard
        className="mb-4"
        label="Outstanding balance"
        value={money(summary.balanceMinor)}
        tone={summary.overdueCount > 0 ? 'bad' : 'default'}
        sub={
          summary.overdueCount > 0
            ? `${summary.overdueCount} payment${summary.overdueCount === 1 ? '' : 's'} overdue`
            : undefined
        }
      />

      <Card className="mb-4">
        <MoneyPair label="Paid to date" value={money(summary.paidToDateMinor)} tone="good" />
        <div className="my-3 h-px bg-line" />
        <MoneyPair
          label={summary.nextDue ? `Next due ${isoDate(summary.nextDue.dueDate)}` : 'Next due'}
          value={summary.nextDue ? money(summary.nextDue.amountMinor) : 'Fully paid'}
          tone={summary.nextDue ? 'default' : 'good'}
        />
        <ProgressBar
          className="mt-4"
          value={paidEntries}
          total={sale.scheduleEntries.length}
          noun="paid"
        />
      </Card>

      <ButtonLink href="/dashboard" className="w-full sm:w-auto">
        Open my dashboard
      </ButtonLink>
    </>
  )
}
