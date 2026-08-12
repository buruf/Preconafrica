import { Image, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import type { PdfImage } from '@/server/media/images'

export interface MastheadProps {
  orgName: string
  /** Project name, then anything else worth naming under it (e.g. location). */
  lines?: Array<string | null>
  /** 'INVOICE', 'RECEIPT', 'STATEMENT' — the word, upper case. */
  docType: string
  docNumber: string
  /** Right-aligned under the number. Omitted where a document has no issue date. */
  issuedAt?: Date
  /**
   * The organisation's logo as *bytes*, already fetched through the SSRF guard —
   * never a URL. Passing a remote URL to @react-pdf's `Image` would have it
   * fetch the address itself, from inside a synchronous render, bypassing every
   * check in `@/server/media/images`: the guard's whole value is that there is
   * exactly one place a user-supplied URL turns into a request.
   *
   * Null — no logo set, or the fetch was refused, timed out, 404'd, came back
   * oversized or in a format a PDF cannot carry — renders the bordered initials
   * placeholder that was here before, in the same 46×46 slot, so the masthead's
   * geometry is identical either way.
   */
  logo?: PdfImage | null
}

/**
 * Initials for the placeholder logo: one letter per word, at most two, so
 * "Sunrise Developments" becomes SD. Falls back to the first two characters of
 * a single-word name, and to nothing at all for a name with no letters in it
 * (in which case the box stays empty rather than printing punctuation).
 */
export function orgInitials(orgName: string): string {
  const words = orgName.split(/\s+/).filter(Boolean)
  const letters = words
    .map((word) => word.replace(/[^A-Za-z0-9]/g, '').charAt(0))
    .filter(Boolean)

  if (letters.length >= 2) return letters.slice(0, 2).join('').toUpperCase()

  const compact = orgName.replace(/[^A-Za-z0-9]/g, '')
  return compact.slice(0, 2).toUpperCase()
}

/**
 * The identity block every document opens with: logo slot, organisation, what
 * this document is and its number.
 *
 * All three document types render it, which is the point of it being a
 * component. It was extracted for the invoice first, with a note that the other
 * two "should not drift away from it" — a note that described an intention and
 * not the code, because for a while only the invoice used it. That meant the
 * developer's letterhead was missing from the statement, which is the one
 * document a buyer keeps, and from every receipt. The three now share it, so
 * `INVOICE`, `STATEMENT` and `RECEIPT` differ below this block and nowhere
 * above it.
 */
export function Masthead(props: MastheadProps) {
  const lines = (props.lines ?? []).filter((line): line is string => Boolean(line))

  return (
    <View style={styles.masthead}>
      <View style={styles.mastheadIdentity}>
        <View style={styles.logoBox}>
          {props.logo ? (
            // `contain`, not `cover`: a logo is a mark, and cropping one to fill
            // a square is worse than the whitespace around it.
            <Image src={props.logo} style={styles.logoImage} />
          ) : (
            <Text style={styles.logoInitials}>{orgInitials(props.orgName)}</Text>
          )}
        </View>
        <View>
          <Text style={styles.orgName}>{props.orgName}</Text>
          {lines.map((line) => (
            <Text key={line} style={styles.muted}>
              {line}
            </Text>
          ))}
        </View>
      </View>
      <View style={styles.mastheadMeta}>
        <Text style={styles.docTitle}>{props.docType}</Text>
        <Text style={styles.docNumber}>{props.docNumber}</Text>
        {props.issuedAt ? (
          <Text style={styles.muted}>Issued {props.issuedAt.toISOString().slice(0, 10)}</Text>
        ) : null}
      </View>
    </View>
  )
}
