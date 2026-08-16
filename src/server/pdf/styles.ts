import { StyleSheet } from '@react-pdf/renderer'

/**
 * The PDF half of the design system.
 *
 * Every colour below is a token from docs/DESIGN.md and every size is a rung of
 * one ladder — because the invoice, the receipt and the statement are the same
 * developer's letterhead and used to be three different documents wearing one
 * masthead: a blue accent that appears nowhere in the product, four status
 * colours a shade off the ones the app draws, and three sets of ad-hoc font
 * sizes. All three now import their type and their colour from here, so a
 * "RECEIPT" cannot end up a different blue from an "INVOICE".
 *
 * Two constraints shape the choices and neither is negotiable:
 *
 *  - **Standard WinAnsi faces only** — Helvetica and Helvetica-Bold, referenced
 *    and never embedded. That is why money prints `NGN 1,234.00` rather than
 *    `₦1,234.00`, and it is why these documents are 3–5 kB: a buyer downloads
 *    them on a phone. Do not add `Font.register`.
 *  - **Colour never carries meaning alone.** These are printed on office mono
 *    lasers as often as they are read on a screen, so every status is a bordered
 *    *word*, every rule is a solid line, and anything that reads only in colour
 *    reads as nothing once it comes out grey.
 */

/* ------------------------------------------------------------------ palette */

/**
 * DESIGN.md's brand pair. `NAVY` draws the masthead rule and every structural
 * line; `TEAL` appears exactly once, as the amount panel's thick left edge —
 * the one accent, on the one figure a reader must not have to hunt for.
 */
const NAVY = '#0E2A47'
const TEAL = '#21A0A0'

const INK = '#0F172A'
const MUTED = '#64748B'
/** `line` — card borders and table rules. */
const LINE = '#E7ECF1'
/** `page` — the app background, and the wash behind a bordered box here. */
const PAGE = '#F6F8FA'

/**
 * The status text colours from DESIGN.md, unchanged. A PAID installment on a
 * statement is the same green as a paid installment on the buyer's dashboard,
 * which is the entire point of the table being in one document.
 *
 * Only the text column is used: a filled pill does not survive a mono print, so
 * the border takes the same colour as the word (see `statusMark`).
 */
const STATUS_PAID = '#15803D'
const STATUS_PARTIAL = '#B45309'
const STATUS_OVERDUE = '#B91C1C'
const STATUS_PENDING = '#64748B'

/**
 * Kept exported under its old name because the three documents and the render
 * tests refer to "the accent". It is now navy — the brand's own colour and the
 * masthead rule DESIGN.md specifies — rather than the stock `#1d4ed8` blue,
 * which appeared nowhere else in the product.
 */
export const ACCENT = NAVY

/* --------------------------------------------------------------------- type */

/**
 * One ladder, mapped from DESIGN.md's screen roles at roughly 0.72 (CSS px to
 * PostScript points). Exported so a document can size something new without
 * inventing an eighth font size.
 *
 * Helvetica's digits are all one width in the standard WinAnsi face, so a column
 * of figures lines up without an OpenType `tnum` feature — which is just as
 * well, since embedding a font is precisely what these documents do not do. The
 * other half of DESIGN.md's tabular-figures rule is alignment, and that is what
 * `figure` below is for.
 */
export const TYPE = {
  /** The organisation's name. DESIGN.md "screen title". */
  title: 16,
  /** 'INVOICE' / 'RECEIPT' / 'STATEMENT'. */
  docType: 14,
  /** The document number, and the one-line label inside the amount panel. */
  docNumber: 11,
  /** A section heading in the body. DESIGN.md "section heading". */
  heading: 12,
  /** Body copy and every table cell. DESIGN.md "body". */
  body: 10,
  /** Labels, captions and the spaced block titles. DESIGN.md "label, caption". */
  label: 8,
  /** The one figure a reader must not hunt for. DESIGN.md "money, prominent". */
  figureHero: 20,
  /** A bordered status word. */
  statusMark: 9
} as const

const BOLD = 'Helvetica-Bold'

export const styles = StyleSheet.create({
  // 36pt margins with the footer at 24 — see `footer`, which is absolutely
  // positioned into that band rather than flowing after the content.
  page: {
    padding: 36,
    paddingBottom: 54,
    fontSize: TYPE.body,
    fontFamily: 'Helvetica',
    color: INK
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  orgName: { fontSize: TYPE.title, fontFamily: BOLD, color: NAVY },
  docTitle: { fontSize: TYPE.docType, fontFamily: BOLD, textAlign: 'right', color: NAVY },
  muted: { color: MUTED },
  section: { marginBottom: 16 },
  /**
   * An in-row label — "Date received", "Purchase price". Body size, muted; the
   * 8pt spaced caption is `blockTitle`, and using that here would leave a 8pt
   * word beside a 10pt figure on every row of the statement.
   */
  label: { color: MUTED, marginBottom: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },

  /**
   * Money, and anything else that can sit above another figure.
   *
   * Right-aligned, which is the half of DESIGN.md's tabular-figures rule that
   * needs stating in a PDF — the digits are already fixed-width (see `TYPE`), so
   * alignment is what actually makes the decimal points stack.
   */
  figure: { textAlign: 'right', fontFamily: BOLD },

  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: NAVY,
    paddingBottom: 4,
    marginBottom: 4,
    fontSize: TYPE.label,
    fontFamily: BOLD,
    color: NAVY
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: LINE
  },
  colSeq: { width: '10%' },
  colDate: { width: '25%' },
  colAmount: { width: '25%', textAlign: 'right' },
  colPaid: { width: '20%', textAlign: 'right' },
  colStatus: { width: '20%', textAlign: 'right' },
  void: { color: STATUS_OVERDUE, fontFamily: BOLD, marginTop: 8 },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 36,
    right: 36,
    fontSize: TYPE.label,
    color: MUTED
  },

  // ── Masthead ───────────────────────────────────────────────────────────────
  masthead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  mastheadIdentity: { flexDirection: 'row', alignItems: 'flex-start' },
  /**
   * The logo slot. A bordered box either way, so a developer who has uploaded
   * nothing gets a deliberate-looking mark rather than a hole in the layout —
   * and so the masthead's geometry does not move once one is set.
   */
  logoBox: {
    width: 46,
    height: 46,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 3,
    backgroundColor: PAGE,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12
  },
  logoInitials: { fontSize: 15, fontFamily: BOLD, color: MUTED, letterSpacing: 1 },
  /**
   * The real logo, in the same slot the initials occupy — inset a point on each
   * side so the mark never touches the border, and `contain` rather than `cover`
   * because a logo cropped to a square is a damaged logo.
   */
  logoImage: { width: 44, height: 44, objectFit: 'contain' },
  mastheadMeta: { alignItems: 'flex-end' },
  docNumber: { fontSize: TYPE.docNumber, fontFamily: BOLD, letterSpacing: 0.6, marginTop: 2 },
  /** DESIGN.md's navy masthead rule, on all three documents. */
  accentRule: { height: 2, backgroundColor: NAVY, marginTop: 10, marginBottom: 18 },

  // ── Building photo band ───────────────────────────────────────────────────
  /**
   * The statement's building photo, under the masthead. A fixed height with the
   * width left to the flex parent, so a developer's photo of any ratio occupies
   * exactly the same band and the page below it never moves — and so the
   * placeholder, which has no intrinsic size at all, occupies it too.
   *
   * 110pt is about 1/7 of an A4 page: enough that a buyer recognises the
   * building, small enough that the schedule still starts on page one.
   */
  heroBand: {
    height: 110,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 3,
    backgroundColor: PAGE,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  heroImage: { width: '100%', height: 110, objectFit: 'cover' },
  /** The label a reader sees when no photo is set, or none could be fetched. */
  heroPlaceholder: {
    fontSize: 9,
    fontFamily: BOLD,
    letterSpacing: 1,
    color: MUTED
  },

  // ── Floor plan ────────────────────────────────────────────────────────────
  /**
   * The floor plan document is the one page here whose *point* is an image, so
   * its geometry is the inverse of every other document's: the facts are a thin
   * strip and the drawing takes what is left.
   *
   * The numbers are not arbitrary. An A4 page is 842pt tall; `page` above takes
   * 36 off the top and 54 off the bottom, leaving 752. The masthead is 46 (the
   * logo slot), the accent rule with its margins is 30, and the two bordered
   * strips are about 46 each with their margins — 192 in total, which leaves
   * roughly 560 for the drawing. 540 is that, less a little slack for
   * line-height rounding, so a plan can never push the context strip onto a
   * second page.
   */
  planStrip: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 3,
    backgroundColor: PAGE,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 12
  },
  /** Four across on the unit strip, two on the context strip below the plan. */
  planCellQuarter: { width: '25%' },
  planCellHalf: { width: '50%' },
  planFact: { fontSize: TYPE.docNumber, fontFamily: BOLD },
  /**
   * The drawing's frame. A fixed height, like `heroBand`, so the page below it
   * does not move depending on whether a plan happened to be uploaded — and so
   * the empty state occupies exactly the space the real thing will.
   */
  planPanel: {
    height: 540,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 3,
    backgroundColor: PAGE,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginBottom: 12
  },
  /**
   * `contain`, never `cover`. A floor plan cropped to fill a frame is a floor
   * plan with rooms missing, which is worse than the letterboxing around it —
   * and cropping a drawing is exactly what this feature may not do.
   */
  planImage: { width: '100%', height: 538, objectFit: 'contain' },
  planEmptyTitle: {
    fontSize: TYPE.heading,
    fontFamily: BOLD,
    letterSpacing: 0.6,
    color: MUTED,
    marginBottom: 6
  },
  /** Wrapped narrow and centred so the empty panel reads as a note, not a wall. */
  planEmptyNote: { width: '70%', textAlign: 'center', color: MUTED },

  // ── Blocks ────────────────────────────────────────────────────────────────
  /** Small, spaced, grey: reads as a heading without needing a second size up. */
  blockTitle: {
    fontSize: TYPE.label,
    fontFamily: BOLD,
    letterSpacing: 1,
    color: MUTED,
    marginBottom: 5
  },
  twoCol: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 18 },
  col: { width: '48%' },
  strong: { fontFamily: BOLD },
  factRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1.5 },
  factLabel: { color: MUTED },

  // ── Amount panel ──────────────────────────────────────────────────────────
  /**
   * The one thing on the page a buyer must not have to hunt for — the amount
   * due on an invoice, the amount received on a receipt. Bordered, on a wash,
   * with the brand's teal carried as a thick left edge, which survives a
   * black-and-white print as a solid rule.
   *
   * This is the only teal in the document set, deliberately: DESIGN.md gives
   * teal to accents, and an accent used twice is not one.
   */
  amountPanel: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderColor: LINE,
    borderLeftWidth: 3,
    borderLeftColor: TEAL,
    backgroundColor: PAGE,
    padding: 12,
    marginBottom: 6
  },
  amountPanelRight: { alignItems: 'flex-end' },
  amountFigure: { fontSize: TYPE.figureHero, fontFamily: BOLD, marginTop: 2, color: NAVY },
  entryLabel: { fontSize: TYPE.docNumber, fontFamily: BOLD },
  statusNote: { marginBottom: 18 },

  /** A bordered word, not a coloured pill: the outline prints. */
  statusMark: {
    alignSelf: 'flex-start',
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 2,
    paddingVertical: 2,
    paddingHorizontal: 5,
    fontSize: TYPE.statusMark,
    fontFamily: BOLD,
    letterSpacing: 0.8
  },
  statusPaid: { color: STATUS_PAID, borderColor: STATUS_PAID },
  statusPartial: { color: STATUS_PARTIAL, borderColor: STATUS_PARTIAL },
  statusOverdue: { color: STATUS_OVERDUE, borderColor: STATUS_OVERDUE },
  statusPending: { color: STATUS_PENDING, borderColor: STATUS_PENDING },

  // ── Closing figures ───────────────────────────────────────────────────────
  // Scheduled, already paid, balance due. There is deliberately no payments
  // table on the invoice any more: an invoice states the balance, and the
  // itemised trail of dates, methods and references is the receipt's job.
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
    marginTop: 6
  },
  summaryTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 5,
    marginTop: 3,
    borderTopWidth: 1,
    borderTopColor: NAVY,
    fontFamily: BOLD
  },
  /** A heading inside the body, for the two sections a receipt is made of. */
  sectionHeading: { fontSize: TYPE.heading, fontFamily: BOLD, color: NAVY, marginBottom: 6 },
  emptyNote: { color: MUTED, paddingVertical: 6 }
})
