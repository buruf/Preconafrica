import { Document, Image, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { Masthead } from '@/server/pdf/Masthead'
import type { PdfImage } from '@/server/media/images'

export interface FloorPlanProps {
  orgName: string
  projectName: string
  projectLocation: string
  expectedCompletion: Date
  /** The unit's own name, e.g. "3B" — the thing the reader is identifying. */
  unitName: string
  floor: number
  bedrooms: number
  /**
   * Already a string. `Unit.sizeSqm` is a Prisma `Decimal`, which is neither a
   * number nor safely stringified by a component, so the caller formats it —
   * the same rule the rest of this app applies to bigint money.
   */
  sizeSqm: string
  /**
   * The organisation's logo as bytes, fetched through the SSRF guard before the
   * render begins — never a URL. Same letterhead as the other three documents;
   * see `MastheadProps.logo`.
   */
  logo: PdfImage | null
  /**
   * The unit's own floor plan drawing, as bytes, fetched through the same
   * guard. Null — none uploaded, or the fetch was refused, timed out, 404'd,
   * came back oversized or in a format a PDF cannot carry — prints the labelled
   * empty panel below rather than failing the render: a buyer tapping a link
   * must never get a 500 or a broken file.
   *
   * There is deliberately no fallback to the project's floor plate. A plate
   * shows four flats; a unit plan shows one. Cropping one out of the other
   * would produce a drawing the architect never issued, with dimensions nobody
   * checked, on the developer's letterhead. If a unit has no plan, this
   * document says so and the developer uploads one.
   */
  plan: PdfImage | null
}

const day = (value: Date) => value.toISOString().slice(0, 10)

/** One labelled fact in either bordered strip. */
function Fact({ label, value, width }: { label: string; value: string; width: 'quarter' | 'half' }) {
  return (
    <View style={width === 'quarter' ? styles.planCellQuarter : styles.planCellHalf}>
      <Text style={styles.blockTitle}>{label}</Text>
      <Text style={styles.planFact}>{value}</Text>
    </View>
  )
}

/**
 * The unit's floor plan, on the developer's letterhead.
 *
 * The odd one out of the four documents, and deliberately so. An invoice, a
 * receipt and a statement are financial records: they carry an org-sequential
 * number, they are stored as `Document` rows, and each one hangs off a sale. A
 * floor plan is none of those things — it is a derived view of the unit's own
 * data, wanted *before* a sale exists (an agent handing it to a walk-in buyer),
 * so there is no sale to hang it on and numbering it would imply a transaction
 * that has not happened. It is rendered live from the unit and nothing is
 * written down.
 *
 * **No price appears anywhere on this page, and none may be added.** A unit's
 * current `priceMinor` and the price snapshotted into a signed sale are
 * different figures, and the same URL serves staff and buyers — so whichever
 * one was printed would be wrong for somebody, and a stale amount circulating
 * on a downloadable PDF is worse than no amount at all. Price belongs on the
 * statement and the invoice, which are the documents that state what is owed.
 */
export function FloorPlanDocument(props: FloorPlanProps) {
  return (
    <Document
      title={`Floor plan — unit ${props.unitName}, ${props.projectName}`}
      author={props.orgName}
    >
      <Page size="A4" style={styles.page}>
        {/* The same letterhead the other three carry, so this sits with them in
            a buyer's downloads folder. The right-hand identifier is the unit
            rather than a document number: there is no sequence to quote, and
            inventing one would say a record exists that does not. */}
        <Masthead
          orgName={props.orgName}
          lines={[props.projectName, props.projectLocation]}
          docType="FLOOR PLAN"
          docNumber={`UNIT ${props.unitName}`}
          logo={props.logo}
        />
        <View style={styles.accentRule} />

        {/* Which unit this is, in one strip — a reader should not have to
            decode the drawing to find out. */}
        <View style={styles.planStrip}>
          <Fact label="UNIT" value={props.unitName} width="quarter" />
          <Fact label="FLOOR" value={String(props.floor)} width="quarter" />
          <Fact
            label="BEDROOMS"
            value={String(props.bedrooms)}
            width="quarter"
          />
          <Fact label="SIZE" value={`${props.sizeSqm} m²`} width="quarter" />
        </View>

        {/* The document. Everything above and below it is a caption. */}
        <View style={styles.planPanel}>
          {props.plan ? (
            <Image src={props.plan} style={styles.planImage} />
          ) : (
            <>
              <Text style={styles.planEmptyTitle}>NO FLOOR PLAN YET</Text>
              <Text style={styles.planEmptyNote}>
                {props.orgName} has not uploaded a drawing for this unit. Ask them for it and
                it will appear here — nothing on this page is a substitute for the
                architect&#8217;s plan.
              </Text>
            </>
          )}
        </View>

        {/* Context, not terms: where the building is and when it is due. */}
        <View style={styles.planStrip}>
          <Fact label="LOCATION" value={props.projectLocation} width="half" />
          <Fact
            label="EXPECTED COMPLETION"
            value={day(props.expectedCompletion)}
            width="half"
          />
        </View>

        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) =>
            `${props.orgName} · Floor plan · Unit ${props.unitName}, ${props.projectName}` +
            (totalPages > 1 ? ` · Page ${pageNumber} of ${totalPages}` : '')
          }
          fixed
        />
      </Page>
    </Document>
  )
}
