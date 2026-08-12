import { Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'

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
   * The organisation's logo, if it has set one.
   *
   * Deliberately not rendered yet: a URL supplied by a user and fetched by the
   * server is an SSRF vector (link-local metadata endpoints, internal hosts,
   * redirect chains), and the one guard that decides which URLs are fetchable
   * belongs in a single place alongside the rest of the imagery work rather than
   * half-built here. Until then the slot shows the placeholder below, which is
   * what an organisation with no logo sees in any case — so wiring the image up
   * later changes what fills the box, not the layout around it.
   */
  logoUrl?: string | null
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
 * this document is and its number. Extracted because the invoice needed a
 * proper one and the other two documents should not drift away from it.
 */
export function Masthead(props: MastheadProps) {
  const lines = (props.lines ?? []).filter((line): line is string => Boolean(line))

  return (
    <View style={styles.masthead}>
      <View style={styles.mastheadIdentity}>
        <View style={styles.logoBox}>
          <Text style={styles.logoInitials}>{orgInitials(props.orgName)}</Text>
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
