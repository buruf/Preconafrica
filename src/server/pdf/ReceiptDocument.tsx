import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { Masthead } from '@/server/pdf/Masthead'
import type { PdfImage } from '@/server/media/images'
import { formatMinor } from '@/domain/currency'
import { scheduleEntryLabel } from '@/domain/schedule'

export interface ReceiptProps {
  number: string
  orgName: string
  /**
   * The organisation's logo as bytes, fetched through the SSRF guard before the
   * render begins — never a URL. Null falls back to the bordered initials in the
   * same 46×46 slot. See `MastheadProps.logo`; a receipt is proof of payment, and
   * proof on unbranded paper is worth less than proof on the developer's own.
   */
  logo: PdfImage | null
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
        {/* The same letterhead the invoice and statement carry. A receipt is the
            document a buyer waves at a site office, and it was the one going out
            with no mark on it. */}
        <Masthead
          orgName={props.orgName}
          lines={[props.projectName]}
          docType="RECEIPT"
          docNumber={props.number}
          logo={props.logo}
        />
        <View style={styles.accentRule} />

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
              {/* A payment that settles the deposit says so. "0" in the
                  applied-to column is the sequence number, not an amount, and
                  reads on a receipt like a payment applied to nothing. */}
              <Text style={styles.colSeq}>{scheduleEntryLabel(a.sequence)}</Text>
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
