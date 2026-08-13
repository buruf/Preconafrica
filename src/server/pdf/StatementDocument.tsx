import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { HeroBand } from '@/server/pdf/HeroBand'
import { Masthead } from '@/server/pdf/Masthead'
import type { PdfImage } from '@/server/media/images'
import { formatMinor } from '@/domain/currency'
import {
  installmentFeeLabel,
  scheduleEntryLabel,
  type InstallmentFeeConfig
} from '@/domain/schedule'
import type { InstallmentStatus } from '@/domain/status'

export interface StatementProps {
  number: string
  orgName: string
  projectName: string
  projectLocation: string
  unitName: string
  /**
   * The organisation's logo as bytes, fetched through the SSRF guard before the
   * render begins — never a URL. Null falls back to the bordered initials in the
   * same 46×46 slot, so the masthead's geometry is identical either way. See
   * `MastheadProps.logo`; this is the same letterhead the invoice carries.
   */
  logo: PdfImage | null
  /**
   * The building photo as bytes, fetched through the SSRF guard before the
   * render begins — never a URL (see `HeroBand`). Null prints the labelled
   * placeholder band, which is also what an unreachable URL produces, so a
   * statement always renders whatever the state of the developer's CDN.
   */
  heroImage: PdfImage | null
  buyerName: string
  buyerPhone: string
  currency: string
  planType: 'FULL' | 'INSTALLMENTS'
  /**
   * The agreed term, straight off the sale. Not `entries.length`: with a
   * deposit the schedule carries one entry more than there are months, so a
   * 36-month contract was printing "37 monthly installments" — the statement
   * contradicting the contract it is a statement of.
   */
  termMonths: number | null
  priceMinor: bigint
  depositMinor: bigint
  /**
   * The charge the sale was signed at, out of its own snapshot. Only the label
   * uses it: `installmentFeeLabel` quotes the rate for a PERCENT charge and
   * quotes nothing for a FIXED one, which is the rule this document must not
   * break — a flat fee is not a percentage of anything, and printing one beside
   * it would put the interest framing back on the buyer's own copy.
   */
  fee: InstallmentFeeConfig
  /** The charge in money, already inside the installments below. */
  feeMinor: bigint
  signedAt: Date
  expectedCompletion: Date
  entries: Array<{
    sequence: number
    dueDate: Date
    amountDueMinor: bigint
    amountPaidMinor: bigint
    status: InstallmentStatus
  }>
  totalMinor: bigint
  paidToDateMinor: bigint
  balanceMinor: bigint
}

const date = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The status column, in DESIGN.md's status colours — the same four the app draws
 * a `StatusPill` with, so a buyer comparing their dashboard to their statement
 * sees one palette rather than two.
 *
 * A coloured *word*, not a filled pill: these are printed on mono lasers, and a
 * word survives that where a tint does not. The style objects also carry a
 * `borderColor`, which is inert here (no `borderWidth`) and is the reason the
 * bordered marks on the invoice and the receipt cannot drift from this column.
 */
const STATUS_STYLE: Record<InstallmentStatus, (typeof styles)['statusPaid']> = {
  PAID: styles.statusPaid,
  PARTIAL: styles.statusPartial,
  OVERDUE: styles.statusOverdue,
  PENDING: styles.statusPending
}

export function StatementDocument(props: StatementProps) {
  return (
    <Document
      // Named like the invoice's and the receipt's, so all three arrive in a
      // buyer's downloads folder with a title rather than as "Untitled".
      title={`Statement ${props.number}`}
      author={props.orgName}
      subject={`Payment statement — Unit ${props.unitName}, ${props.projectName}`}
    >
      <Page size="A4" style={styles.page}>
        {/* The same letterhead the invoice and receipt carry, logo and all —
            this document was printing the org's name in a plain header while the
            invoice printed its mark. */}
        <Masthead
          orgName={props.orgName}
          lines={[props.projectName, props.projectLocation]}
          docType="STATEMENT"
          docNumber={props.number}
          logo={props.logo}
        />
        <View style={styles.accentRule} />

        {/* Under the masthead, before the terms. A buyer's statement is the one
            document they keep, and it described a building they had never seen a
            picture of. */}
        <HeroBand image={props.heroImage} />

        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>Buyer</Text>
            <Text>{props.buyerName} · {props.buyerPhone}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Unit</Text>
            <Text>{props.unitName}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Plan</Text>
            <Text>
              {props.planType === 'FULL'
                ? 'Full payment'
                : `${props.termMonths ?? 0} monthly installments`}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Signed</Text>
            <Text>{date(props.signedAt)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Expected completion</Text>
            <Text>{date(props.expectedCompletion)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Purchase price</Text>
            <Text style={styles.figure}>{formatMinor(props.priceMinor, props.currency)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Deposit (due at signing)</Text>
            <Text style={styles.figure}>{formatMinor(props.depositMinor, props.currency)}</Text>
          </View>
          {props.feeMinor > 0n ? (
            <View style={styles.row}>
              {/* `installmentFeeLabel` quotes the rate for a PERCENT charge and
                  quotes nothing for a FIXED one. A percentage beside a flat fee
                  is the one thing this document must never print. */}
              <Text style={styles.label}>{installmentFeeLabel(props.fee)}</Text>
              <Text style={styles.figure}>{formatMinor(props.feeMinor, props.currency)}</Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.sectionHeading}>Payment schedule</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.colSeq}>#</Text>
          <Text style={styles.colDate}>DUE DATE</Text>
          <Text style={styles.colAmount}>AMOUNT</Text>
          <Text style={styles.colPaid}>PAID</Text>
          <Text style={styles.colStatus}>STATUS</Text>
        </View>
        {props.entries.map((entry) => (
          <View key={entry.sequence} style={styles.tableRow} wrap={false}>
            <Text style={styles.colSeq}>{scheduleEntryLabel(entry.sequence)}</Text>
            <Text style={styles.colDate}>{date(entry.dueDate)}</Text>
            <Text style={styles.colAmount}>{formatMinor(entry.amountDueMinor, props.currency)}</Text>
            <Text style={styles.colPaid}>{formatMinor(entry.amountPaidMinor, props.currency)}</Text>
            <Text style={[styles.colStatus, STATUS_STYLE[entry.status]]}>{entry.status}</Text>
          </View>
        ))}

        {/* "Total owed", not "Total scheduled": with an installment charge the
            price is no longer what the buyer owes, and this figure — the sum of
            the rows above — is. Naming it after the schedule invited the reader
            to compare it against the purchase price and conclude the statement
            was wrong. */}
        <View style={styles.summaryTotal}>
          <Text>Total owed</Text>
          <Text style={styles.figure}>{formatMinor(props.totalMinor, props.currency)}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.muted}>Paid to date</Text>
          <Text style={styles.figure}>{formatMinor(props.paidToDateMinor, props.currency)}</Text>
        </View>
        <View style={styles.summaryTotal}>
          <Text>Balance</Text>
          <Text style={styles.figure}>{formatMinor(props.balanceMinor, props.currency)}</Text>
        </View>

        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) =>
            `${props.orgName} · Statement ${props.number} · Page ${pageNumber} of ${totalPages}`
          }
          fixed
        />
      </Page>
    </Document>
  )
}
