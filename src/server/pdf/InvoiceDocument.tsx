import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { formatMinor } from '@/domain/currency'
import { DEPOSIT_SEQUENCE } from '@/domain/schedule'

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
  amountPaidMinor: bigint
}

const date = (d: Date) => d.toISOString().slice(0, 10)

export function InvoiceDocument(props: InvoiceProps) {
  const outstanding = props.amountDueMinor - props.amountPaidMinor

  // The deposit is a schedule entry like any other, so it gets invoiced like
  // any other — but it is not installment zero of anything, and printing it
  // that way makes a correct invoice look like a broken one.
  const isDeposit = props.sequence === DEPOSIT_SEQUENCE

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
            <Text style={styles.label}>{isDeposit ? 'Deposit' : 'Installment'}</Text>
            <Text>
              {isDeposit
                ? 'Due at signing'
                : props.termMonths === null
                  ? 'Full payment'
                  : `${props.sequence} of ${props.termMonths}`}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Due date</Text>
            <Text>{date(props.dueDate)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text>{isDeposit ? 'Deposit amount' : 'Installment amount'}</Text>
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
