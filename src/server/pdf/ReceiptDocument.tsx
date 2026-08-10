import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { formatMinor } from '@/domain/currency'

export interface ReceiptProps {
  number: string
  orgName: string
  projectName: string
  unitName: string
  buyerName: string
  currency: string
  amountMinor: bigint
  receivedAt: Date
  method: string
  reference: string | null
  allocations: Array<{ sequence: number; dueDate: Date; amountMinor: bigint }>
  balanceMinor: bigint
  voided: boolean
  voidReason: string | null
}

const date = (d: Date) => d.toISOString().slice(0, 10)
const methodLabel = (m: string) => m.replace(/_/g, ' ').toLowerCase()

export function ReceiptDocument(props: ReceiptProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.orgName}>{props.orgName}</Text>
            <Text style={styles.muted}>{props.projectName}</Text>
          </View>
          <View>
            <Text style={styles.docTitle}>RECEIPT</Text>
            <Text style={styles.muted}>{props.number}</Text>
          </View>
        </View>

        {props.voided ? (
          <Text style={styles.void}>VOID — {props.voidReason ?? 'this payment was reversed'}</Text>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.label}>Received from</Text>
          <Text>{props.buyerName}</Text>
          <Text style={styles.muted}>Unit {props.unitName}</Text>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>Date received</Text>
            <Text>{date(props.receivedAt)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Method</Text>
            <Text>{methodLabel(props.method)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Reference</Text>
            <Text>{props.reference ?? '—'}</Text>
          </View>
          <View style={styles.total}>
            <Text>Amount received</Text>
            <Text>{formatMinor(props.amountMinor, props.currency)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Applied to</Text>
          <View style={styles.tableHeader}>
            <Text style={styles.colSeq}>#</Text>
            <Text style={styles.colDate}>Due date</Text>
            <Text style={styles.colAmount}>Applied</Text>
          </View>
          {props.allocations.map((a) => (
            <View key={a.sequence} style={styles.tableRow}>
              <Text style={styles.colSeq}>{a.sequence}</Text>
              <Text style={styles.colDate}>{date(a.dueDate)}</Text>
              <Text style={styles.colAmount}>{formatMinor(a.amountMinor, props.currency)}</Text>
            </View>
          ))}
          <View style={styles.total}>
            <Text>Balance remaining</Text>
            <Text>{formatMinor(props.balanceMinor, props.currency)}</Text>
          </View>
        </View>

        <Text style={styles.footer}>{props.orgName} · Receipt {props.number}</Text>
      </Page>
    </Document>
  )
}
