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

/**
 * Proof that money arrived.
 *
 * It shares the invoice's letterhead, and now the invoice's *layout* too: the
 * same `blockTitle` captions, the same bordered status word, and the same amount
 * panel carrying the one figure the reader came for. It was the odd one out — a
 * flat list of label/value rows with the sum buried in the middle — which meant
 * a buyer holding an invoice and its receipt was holding two documents that
 * looked like they came from different systems.
 */
export function ReceiptDocument(props: ReceiptProps) {
  const money = (amount: bigint) => formatMinor(amount, props.currency)

  return (
    <Document
      title={`Receipt ${props.number}`}
      author={props.orgName}
      subject={`Payment received — Unit ${props.unitName}, ${props.projectName}`}
    >
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

        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Text style={styles.blockTitle}>RECEIVED FROM</Text>
            <Text style={styles.strong}>{props.buyerName}</Text>
            <Text style={styles.muted}>Unit {props.unitName}</Text>
            <Text style={styles.muted}>{props.projectName}</Text>
          </View>
          <View style={styles.col}>
            <Text style={styles.blockTitle}>PAYMENT</Text>
            <View style={styles.factRow}>
              <Text style={styles.factLabel}>Date received</Text>
              <Text>{date(props.receivedAt)}</Text>
            </View>
            <View style={styles.factRow}>
              <Text style={styles.factLabel}>Method</Text>
              <Text>{methodLabel(props.method)}</Text>
            </View>
            <View style={styles.factRow}>
              <Text style={styles.factLabel}>Reference</Text>
              <Text>{props.reference ?? '—'}</Text>
            </View>
          </View>
        </View>

        {/* The invoice's amount panel, with the figure that arrived rather than
            the figure demanded. The status word is bordered, not filled, so it
            survives a mono print — and a voided receipt says so twice, here and
            in the line above, because a struck payment that reads as a valid one
            is the worst thing this document could do. */}
        <View style={styles.amountPanel}>
          <View>
            <Text style={styles.entryLabel}>Amount received</Text>
            <Text style={styles.muted}>
              {date(props.receivedAt)} · {methodLabel(props.method)}
            </Text>
            <Text
              style={[styles.statusMark, props.voided ? styles.statusOverdue : styles.statusPaid]}
            >
              {props.voided ? 'VOIDED' : 'RECEIVED'}
            </Text>
          </View>
          <View style={styles.amountPanelRight}>
            <Text style={styles.blockTitle}>PAID</Text>
            <Text style={styles.amountFigure}>{money(props.amountMinor)}</Text>
          </View>
        </View>
        <Text style={[styles.muted, styles.statusNote]}>
          {props.voided
            ? 'This receipt has been voided. The payment it recorded no longer counts towards the balance.'
            : 'Applied to the installments below in due-date order. Keep this receipt.'}
        </Text>

        <Text style={styles.sectionHeading}>Applied to</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.colSeq}>#</Text>
          <Text style={styles.colDate}>DUE DATE</Text>
          <Text style={styles.colAmount}>APPLIED</Text>
        </View>
        {props.allocations.map((allocation) => (
          <View key={allocation.sequence} style={styles.tableRow} wrap={false}>
            {/* A payment that settles the deposit says so. "0" in the applied-to
                column is the sequence number, not an amount, and reads on a
                receipt like a payment applied to nothing. */}
            <Text style={styles.colSeq}>{scheduleEntryLabel(allocation.sequence)}</Text>
            <Text style={styles.colDate}>{date(allocation.dueDate)}</Text>
            <Text style={styles.colAmount}>{money(allocation.amountMinor)}</Text>
          </View>
        ))}

        <View style={styles.summaryTotal}>
          <Text>Balance remaining</Text>
          <Text style={styles.figure}>{money(props.balanceMinor)}</Text>
        </View>

        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) =>
            `${props.orgName} · Receipt ${props.number}` +
            (totalPages > 1 ? ` · Page ${pageNumber} of ${totalPages}` : '')
          }
          fixed
        />
      </Page>
    </Document>
  )
}
