import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { formatMinor } from '@/domain/currency'
import { bpsToPercentString, scheduleEntryLabel } from '@/domain/schedule'
import type { InstallmentStatus } from '@/domain/status'

export interface StatementProps {
  number: string
  orgName: string
  projectName: string
  projectLocation: string
  unitName: string
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
  /** Basis points, for the rate quoted beside the charge. Zero prints nothing. */
  markupBps: number
  /** The charge in money, already inside the installments below. */
  markupMinor: bigint
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

export function StatementDocument(props: StatementProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.orgName}>{props.orgName}</Text>
            <Text style={styles.muted}>{props.projectName}</Text>
            <Text style={styles.muted}>{props.projectLocation}</Text>
          </View>
          <View>
            <Text style={styles.docTitle}>STATEMENT</Text>
            <Text style={styles.muted}>{props.number}</Text>
          </View>
        </View>

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
            <Text>{formatMinor(props.priceMinor, props.currency)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Deposit (due at signing)</Text>
            <Text>{formatMinor(props.depositMinor, props.currency)}</Text>
          </View>
          {props.markupMinor > 0n ? (
            <View style={styles.row}>
              <Text style={styles.label}>
                Installment charge ({bpsToPercentString(props.markupBps)}%)
              </Text>
              <Text>{formatMinor(props.markupMinor, props.currency)}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.tableHeader}>
          <Text style={styles.colSeq}>#</Text>
          <Text style={styles.colDate}>Due date</Text>
          <Text style={styles.colAmount}>Amount</Text>
          <Text style={styles.colPaid}>Paid</Text>
          <Text style={styles.colStatus}>Status</Text>
        </View>
        {props.entries.map((entry) => (
          <View key={entry.sequence} style={styles.tableRow} wrap={false}>
            <Text style={styles.colSeq}>{scheduleEntryLabel(entry.sequence)}</Text>
            <Text style={styles.colDate}>{date(entry.dueDate)}</Text>
            <Text style={styles.colAmount}>{formatMinor(entry.amountDueMinor, props.currency)}</Text>
            <Text style={styles.colPaid}>{formatMinor(entry.amountPaidMinor, props.currency)}</Text>
            <Text style={styles.colStatus}>{entry.status}</Text>
          </View>
        ))}

        {/* "Total owed", not "Total scheduled": with an installment charge the
            price is no longer what the buyer owes, and this figure — the sum of
            the rows above — is. Naming it after the schedule invited the reader
            to compare it against the purchase price and conclude the statement
            was wrong. */}
        <View style={styles.total}>
          <Text>Total owed</Text>
          <Text>{formatMinor(props.totalMinor, props.currency)}</Text>
        </View>
        <View style={styles.total}>
          <Text>Paid to date</Text>
          <Text>{formatMinor(props.paidToDateMinor, props.currency)}</Text>
        </View>
        <View style={styles.total}>
          <Text>Balance</Text>
          <Text>{formatMinor(props.balanceMinor, props.currency)}</Text>
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
