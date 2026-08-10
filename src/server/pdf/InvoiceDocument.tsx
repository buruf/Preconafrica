import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { formatMinor } from '@/domain/currency'

export interface InvoiceProps {
  number: string
  issuedAt: Date
  orgName: string
  projectName: string
  unitName: string
  buyerName: string
  buyerPhone: string
  buyerEmail: string
  currency: string
  sequence: number
  totalInstallments: number
  dueDate: Date
  amountDueMinor: bigint
  amountPaidMinor: bigint
}

const date = (d: Date) => d.toISOString().slice(0, 10)

export function InvoiceDocument(props: InvoiceProps) {
  const outstanding = props.amountDueMinor - props.amountPaidMinor

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.orgName}>{props.orgName}</Text>
            <Text style={styles.muted}>{props.projectName}</Text>
          </View>
          <View>
            <Text style={styles.docTitle}>INVOICE</Text>
            <Text style={styles.muted}>{props.number}</Text>
            <Text style={styles.muted}>Issued {date(props.issuedAt)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Billed to</Text>
          <Text>{props.buyerName}</Text>
          <Text style={styles.muted}>{props.buyerPhone}</Text>
          <Text style={styles.muted}>{props.buyerEmail}</Text>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>Unit</Text>
            <Text>{props.unitName}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Installment</Text>
            <Text>
              {props.sequence} of {props.totalInstallments}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Due date</Text>
            <Text>{date(props.dueDate)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text>Installment amount</Text>
            <Text>{formatMinor(props.amountDueMinor, props.currency)}</Text>
          </View>
          <View style={styles.row}>
            <Text>Already paid</Text>
            <Text>{formatMinor(props.amountPaidMinor, props.currency)}</Text>
          </View>
          <View style={styles.total}>
            <Text>Amount due</Text>
            <Text>{formatMinor(outstanding > 0n ? outstanding : 0n, props.currency)}</Text>
          </View>
        </View>

        <Text style={styles.footer}>
          {props.orgName} · Invoice {props.number} · Please quote this number with your payment.
        </Text>
      </Page>
    </Document>
  )
}
