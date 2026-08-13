import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { Masthead } from '@/server/pdf/Masthead'
import type { PdfImage } from '@/server/media/images'
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
   * The entry's own maintained total — the single source for both the
   * paid-so-far line and the outstanding figure, so the two cannot disagree.
   *
   * A bill states what remains outstanding, and it needs this to do that. What
   * it deliberately does not do is itemise *how* that total was reached: the
   * dates, methods, references and recorder names of the payments behind it are
   * the receipt's audit trail, and reproducing them here made a demand for
   * payment read like a proof of payment. Derived from the entry, never from
   * allocation rows.
   */
  amountPaidMinor: bigint
  /** Derived by the caller with `deriveStatus`, so "now" is decided once. */
  status: InstallmentStatus
}

const date = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The status treatment. All four are reachable: an invoice is issuable for any
 * installment, so a brand-new one on an installment nothing has been paid
 * against prints PENDING (or OVERDUE, past its date), which is the ordinary
 * case for a bill.
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

        {/* What a bill owes the reader and nothing more: the scheduled amount,
            anything already credited against it, and the balance being asked
            for. Both figures come from `amountDueMinor`/`amountPaidMinor`, so
            no allocation row is read and no payment is itemised — that detail
            belongs to the receipt. */}
        <View style={styles.summaryRow}>
          <Text style={styles.muted}>Amount scheduled</Text>
          <Text>{money(props.amountDueMinor)}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.muted}>Already paid</Text>
          <Text>{money(props.amountPaidMinor)}</Text>
        </View>
        <View style={styles.summaryTotal}>
          <Text>Balance due</Text>
          <Text>{money(outstanding)}</Text>
        </View>
        <Text style={[styles.muted, styles.emptyNote]}>
          A receipt is issued for every payment received and lists its date, method and reference.
        </Text>

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
