import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { formatMinor } from '@/domain/currency'
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
  priceMinor: bigint
  depositMinor: bigint
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
                : `${props.entries.length} monthly installments`}
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
            <Text style={styles.label}>Deposit</Text>
            <Text>{formatMinor(props.depositMinor, props.currency)}</Text>
          </View>
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
            <Text style={styles.colSeq}>{entry.sequence}</Text>
            <Text style={styles.colDate}>{date(entry.dueDate)}</Text>
            <Text style={styles.colAmount}>{formatMinor(entry.amountDueMinor, props.currency)}</Text>
            <Text style={styles.colPaid}>{formatMinor(entry.amountPaidMinor, props.currency)}</Text>
            <Text style={styles.colStatus}>{entry.status}</Text>
          </View>
        ))}

        <View style={styles.total}>
          <Text>Total scheduled</Text>
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
