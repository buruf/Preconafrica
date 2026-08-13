import { StyleSheet } from '@react-pdf/renderer'

/**
 * One accent, used for the masthead rule, the document type and the amount
 * panel's edge — and nowhere else. Every other distinction on the page is made
 * with weight, size and space, because these documents are printed on office
 * mono lasers as often as they are read on a screen, and anything that carries
 * meaning only in colour carries none once it comes out grey.
 */
export const ACCENT = '#1d4ed8'

const INK = '#0f172a'
const MUTED = '#64748b'
const FAINT = '#94a3b8'
const RULE = '#cbd5e1'
const HAIRLINE = '#e2e8f0'
const WASH = '#f8fafc'

export const styles = StyleSheet.create({
  // 36pt margins with the footer at 24 — see `footer`, which is absolutely
  // positioned into that band rather than flowing after the content.
  page: { padding: 36, paddingBottom: 54, fontSize: 10, fontFamily: 'Helvetica', color: INK },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  orgName: { fontSize: 16, fontFamily: 'Helvetica-Bold' },
  docTitle: { fontSize: 14, fontFamily: 'Helvetica-Bold', textAlign: 'right', color: ACCENT },
  muted: { color: MUTED },
  faint: { color: FAINT },
  section: { marginBottom: 16 },
  label: { color: MUTED, marginBottom: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: RULE,
    paddingBottom: 4,
    marginBottom: 4,
    fontFamily: 'Helvetica-Bold'
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: HAIRLINE
  },
  colSeq: { width: '10%' },
  colDate: { width: '25%' },
  colAmount: { width: '25%', textAlign: 'right' },
  colPaid: { width: '20%', textAlign: 'right' },
  colStatus: { width: '20%', textAlign: 'right' },
  total: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, fontFamily: 'Helvetica-Bold' },
  void: { color: '#b91c1c', fontFamily: 'Helvetica-Bold', marginTop: 8 },
  footer: { position: 'absolute', bottom: 24, left: 36, right: 36, fontSize: 8, color: FAINT },

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
    borderColor: RULE,
    borderRadius: 3,
    backgroundColor: WASH,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12
  },
  logoInitials: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: FAINT, letterSpacing: 1 },
  /**
   * The real logo, in the same slot the initials occupy — inset a point on each
   * side so the mark never touches the border, and `contain` rather than `cover`
   * because a logo cropped to a square is a damaged logo.
   */
  logoImage: { width: 44, height: 44, objectFit: 'contain' },
  mastheadMeta: { alignItems: 'flex-end' },
  docNumber: { fontSize: 11, fontFamily: 'Helvetica-Bold', letterSpacing: 0.6, marginTop: 2 },
  accentRule: { height: 2, backgroundColor: ACCENT, marginTop: 10, marginBottom: 18 },

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
    borderColor: RULE,
    borderRadius: 3,
    backgroundColor: WASH,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  heroImage: { width: '100%', height: 110, objectFit: 'cover' },
  /** The label a reader sees when no photo is set, or none could be fetched. */
  heroPlaceholder: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1,
    color: FAINT
  },

  // ── Blocks ────────────────────────────────────────────────────────────────
  /** Small, spaced, grey: reads as a heading without needing a second size up. */
  blockTitle: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1,
    color: MUTED,
    marginBottom: 5
  },
  twoCol: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 18 },
  col: { width: '48%' },
  strong: { fontFamily: 'Helvetica-Bold' },
  factRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1.5 },
  factLabel: { color: MUTED },

  // ── Amount panel ──────────────────────────────────────────────────────────
  /**
   * The one thing on the page a buyer must not have to hunt for. Bordered, on a
   * wash, with the accent carried as a thick left edge — which survives a
   * black-and-white print as a solid rule.
   */
  amountPanel: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderColor: RULE,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT,
    backgroundColor: WASH,
    padding: 12,
    marginBottom: 6
  },
  amountPanelRight: { alignItems: 'flex-end' },
  amountFigure: { fontSize: 20, fontFamily: 'Helvetica-Bold', marginTop: 2 },
  entryLabel: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  statusNote: { marginBottom: 18 },

  /** A bordered word, not a coloured pill: the outline prints. */
  statusMark: {
    alignSelf: 'flex-start',
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 2,
    paddingVertical: 2,
    paddingHorizontal: 5,
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.8
  },
  statusPaid: { color: '#047857', borderColor: '#047857' },
  statusPartial: { color: '#b45309', borderColor: '#b45309' },
  statusOverdue: { color: '#b91c1c', borderColor: '#b91c1c' },
  statusPending: { color: '#475569', borderColor: FAINT },

  // ── The invoice's closing figures ─────────────────────────────────────────
  // Scheduled, already paid, balance due. There is deliberately no payments
  // table here any more: an invoice states the balance, and the itemised trail
  // of dates, methods and references is the receipt's job.
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2, marginTop: 6 },
  summaryTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 5,
    marginTop: 3,
    borderTopWidth: 1,
    borderTopColor: RULE,
    fontFamily: 'Helvetica-Bold'
  },
  emptyNote: { color: MUTED, paddingVertical: 6 }
})
