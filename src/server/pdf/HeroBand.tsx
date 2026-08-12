import { Image, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import type { PdfImage } from '@/server/media/images'

/**
 * The building photo band. One component so the placeholder is written once —
 * the same rule the web pages follow with `MediaPlaceholder`.
 *
 * Takes *bytes*, never a URL: @react-pdf's `Image` will happily fetch a remote
 * address from inside a synchronous render, which would put a user-supplied URL
 * on the network without passing the SSRF guard. Everything is fetched up front
 * in `renderDocumentPdf` and arrives here already decided.
 *
 * A null image — none set, refused by the guard, timed out, 404, oversized, or a
 * format a PDF cannot carry — prints the labelled box instead. The band is a
 * fixed height either way, so the page's layout does not depend on whether a
 * photo happened to be reachable at render time.
 */
export function HeroBand({
  image,
  label = 'BUILDING PHOTO'
}: {
  image: PdfImage | null
  label?: string
}) {
  return (
    <View style={styles.heroBand}>
      {image ? (
        <Image src={image} style={styles.heroImage} />
      ) : (
        <Text style={styles.heroPlaceholder}>{label}</Text>
      )}
    </View>
  )
}
