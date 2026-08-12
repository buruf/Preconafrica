import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { Masthead } from '@/server/pdf/Masthead'
import type { PdfImage } from '@/server/media/images'
import type { InvoicePaymentRow } from '@/server/pdf/invoice-payments'
import { formatMinor } from '@/domain/currency'
import { DEPOSIT_SEQUENCE } from '@/domain/schedule'
import { outstandingMinor, type InstallmentStatus } from '@/domain/status'

export interface InvoiceProps {
  number: string
  issuedAt: Date
  orgName: string
  /**
   * The organisation's logo as bytes, already fetched through the SSRF guard —
   * not a URL. Null (no logo set, or one that could not be fetched safely) falls
   * back to the bordered initials placeholder in the same 46×46 slot, so the
   * masthead's geometry is the same either way. See `MastheadProps.logo`.
   */
  logo: PdfImage | null
  projectName: string
  projectLocation: string
  unitName: string
  buyerName: string
  buyerPhone: string
  buyerEmail: string
  buyerAddress: string | null
  currency: string
  sequence: number
  /**
   * The contract's term in months — the denominator of "installment 3 of 36".
   * Not the number of schedule entries: a schedule with a deposit has one more
   * row than the contract has months, which turned every invoice on a
   * deposit-bearing sale into "3 of 37". Null for a full payment, which has no
   * installments to count.
   */
  termMonths: number | null
  dueDate: Date
  amountDueMinor: bigint
  /**
   * The entry's maintained total, which is the sum of the allocations listed in
   * `payments`. Used for both the paid-so-far and outstanding figures so the two
   * cannot disagree with each other, whatever the rows happen to add up to.
   */
  amountPaidMinor: bigint
  /** Derived by the caller with `deriveStatus`, so "now" is decided once. */
  status: InstallmentStatus
  /** Every payment allocated to this installment, oldest first. */
  payments: InvoicePaymentRow[]
}

const date = (d: Date) => d.toISOString().slice(0, 10)
const methodLabel = (m: string) => m.replace(/_/g, ' ').toLowerCase()

/**
 * The status treatment. An invoice can only be issued once something has been
 * paid, so PENDING is unreachable on a fresh one — but an invoice issued and
 * then voided back to zero keeps its document, and it still has to print.
 */
const STATUS_MARK: Record<
  InstallmentStatus,
  { mark: string; style: (typeof styles)['statusPaid'] }
> = {
  PAID: { mark: 'PAID IN FULL', style: styles.statusPaid },
  PARTIAL: { mark: 'PART PAID', style: styles.statusPartial },
  OVERDUE: { mark: 'OVERDUE', style: styles.statusOverdue },
  PENDING: { mark: 'NOT YET PAID', style: styles.statusPending }
}

function statusNote(status: InstallmentStatus, dueDate: Date): string {
  switch (status) {
    case 'PAID':
      return 'Settled in full. No further payment is due on this installment.'
    case 'PARTIAL':
      return 'Part paid. The balance shown above remains outstanding.'
    case 'OVERDUE':
      return `Past due since ${date(dueDate)}. The balance shown above remains outstanding.`
    case 'PENDING':
      return 'Nothing has been received against this installment yet.'
  }
}

export function InvoiceDocument(props: InvoiceProps) {
  const outstanding = outstandingMinor(props)
  const money = (amount: bigint) => formatMinor(amount, props.currency)

  // The deposit is a schedule entry like any other, so it gets invoiced like
  // any other — but it is not installment zero of anything, and printing it
  // that way makes a correct invoice look like a broken one.
  const isDeposit = props.sequence === DEPOSIT_SEQUENCE
  const entryLabel = isDeposit
    ? 'Deposit'
    : props.termMonths === null
      ? 'Full payment'
      : `Installment ${props.sequence} of ${props.termMonths}`

  const { mark, style: markStyle } = STATUS_MARK[props.status]

  return (
    <Document
      title={`Invoice ${props.number}`}
      author={props.orgName}
      subject={`${entryLabel} — Unit ${props.unitName}, ${props.projectName}`}
    >
      <Page size="A4" style={styles.page}>
        <Masthead
          orgName={props.orgName}
          lines={[props.projectName, props.projectLocation]}
          docType="INVOICE"
          docNumber={props.number}
          issuedAt={props.issuedAt}
          logo={props.logo}
        />
        <View style={styles.accentRule} />

        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Text style={styles.blockTitle}>BILLED TO</Text>
            <Text style={styles.strong}>{props.buyerName}</Text>
            <Text style={styles.muted}>{props.buyerPhone}</Text>
            <Text style={styles.muted}>{props.buyerEmail}</Text>
            {props.buyerAddress ? <Text style={styles.muted}>{props.buyerAddress}</Text> : null}
          </View>
          <View style={styles.col}>
            <Text style={styles.blockTitle}>PROPERTY</Text>
            <View style={styles.factRow}>
              <Text style={styles.factLabel}>Unit</Text>
              <Text style={styles.strong}>{props.unitName}</Text>
            </View>
            <View style={styles.factRow}>
              <Text style={styles.factLabel}>Project</Text>
              <Text>{props.projectName}</Text>
            </View>
            <View style={styles.factRow}>
              <Text style={styles.factLabel}>Due date</Text>
              <Text>{date(props.dueDate)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.amountPanel}>
          <View>
            <Text style={styles.entryLabel}>{entryLabel}</Text>
            <Text style={styles.muted}>
              {isDeposit ? 'Due at signing · ' : 'Due '}
              {date(props.dueDate)}
            </Text>
            <Text style={[styles.statusMark, markStyle]}>{mark}</Text>
          </View>
          <View style={styles.amountPanelRight}>
            <Text style={styles.blockTitle}>AMOUNT DUE</Text>
            <Text style={styles.amountFigure}>{money(outstanding)}</Text>
            <Text style={styles.muted}>of {money(props.amountDueMinor)} scheduled</Text>
          </View>
        </View>
        <Text style={[styles.muted, styles.statusNote]}>{statusNote(props.status, props.dueDate)}</Text>

        <Text style={styles.blockTitle}>PAYMENTS RECEIVED AGAINST THIS INSTALLMENT</Text>
        {props.payments.length === 0 ? (
          <Text style={styles.emptyNote}>No payments are recorded against this installment.</Text>
        ) : (
          <>
            <View style={styles.tableHeader}>
              <Text style={styles.colPayDate}>Received</Text>
              <Text style={styles.colPayMethod}>Method</Text>
              <Text style={styles.colPayRef}>Reference</Text>
              <Text style={styles.colPayBy}>Recorded by</Text>
              <Text style={styles.colPayAmount}>Applied</Text>
            </View>
            {props.payments.map((payment, index) => (
              <View
                // Nothing here is unique on its own — one payment can be split
                // across installments and two cash payments can share a day and
                // an amount — and the list is a stable ordered render, so the
                // index is the honest key.
                key={`${date(payment.receivedAt)}-${index}`}
                style={styles.tableRow}
                wrap={false}
              >
                <Text style={styles.colPayDate}>{date(payment.receivedAt)}</Text>
                <Text style={styles.colPayMethod}>{methodLabel(payment.method)}</Text>
                <Text style={styles.colPayRef}>{payment.reference ?? '—'}</Text>
                <Text style={styles.colPayBy}>{payment.recordedBy}</Text>
                <Text style={styles.colPayAmount}>{money(payment.amountMinor)}</Text>
              </View>
            ))}
          </>
        )}

        <View style={styles.summaryRow}>
          <Text style={styles.muted}>Paid so far</Text>
          <Text>{money(props.amountPaidMinor)}</Text>
        </View>
        <View style={styles.summaryTotal}>
          <Text>Still outstanding</Text>
          <Text>{money(outstanding)}</Text>
        </View>

        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) =>
            `${props.orgName} · Invoice ${props.number} · Please quote this number with your payment.` +
            (totalPages > 1 ? ` · Page ${pageNumber} of ${totalPages}` : '')
          }
          fixed
        />
      </Page>
    </Document>
  )
}
