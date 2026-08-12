import { lookup } from 'node:dns/promises'
import { checkImageUrl, isBlockedAddress } from '@/domain/media'

/**
 * The only way this server fetches an image URL a user supplied.
 *
 * Every rule that decides *whether* a URL is fetchable lives in `@/domain/media`
 * (pure, tested); this module adds the two things that need the outside world:
 * DNS resolution, because a perfectly public-looking hostname can resolve to
 * 10.0.0.5, and a fetch with limits, because "it is an https URL to a public
 * address" says nothing about whether the response is an image, or 400MB, or
 * ever going to arrive.
 *
 * Nothing here throws. A rejection, a timeout, a 404, an oversize body and a
 * host that does not resolve all produce the same answer — `null` — because the
 * caller's fallback is a placeholder box, and a bad URL must never be able to
 * break a PDF render or a page. Failures are logged once, server-side, with the
 * reason, so an admin who pasted something wrong can be told why.
 */

/** Long enough for a CDN on a slow link, short enough that a PDF still renders. */
export const IMAGE_FETCH_TIMEOUT_MS = 5_000

/** Hard cap on what is read off the wire, enforced while reading, not after. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * What may be *embedded in a PDF*, which is a much smaller number than what may
 * be fetched. These documents are downloaded by buyers on metered mobile data;
 * a 4MB hero photo would turn a 6 kB statement into a 4MB one. Past this the
 * image is dropped and the placeholder prints instead — the document stays
 * small and still says what belongs in the space. Web pages are unaffected:
 * the browser fetches those directly, lazily, and never through this module.
 */
export const MAX_PDF_IMAGE_BYTES = 300 * 1024

export interface FetchedImage {
  bytes: Buffer
  /** Lower-cased, parameters stripped: `image/png`, not `image/png; qs=0.9`. */
  contentType: string
}

/** What `@react-pdf/renderer`'s `Image` accepts without touching the network. */
export interface PdfImage {
  data: Buffer
  format: 'png' | 'jpg'
}

/**
 * Drops the rest of a response body, and swallows the failure to do so.
 *
 * `cancel()` on a stream that has already errored returns a *rejected* promise
 * carrying that error, and an unhandled rejection is fatal to the process under
 * Node's default `--unhandled-rejections=throw`. So every abandonment of a body
 * goes through here: a module whose whole contract is "nothing throws, every
 * failure is null" must not be able to take the server down while giving up on a
 * download it had already decided to refuse.
 */
function discard(body: { cancel: () => Promise<void> } | null | undefined): void {
  void body?.cancel().catch(() => {})
}

function refuse(url: string, reason: string): null {
  // One line, the reason first: this is the only trace of a rejected fetch, and
  // the URL is second because it may be long. Not an error — a refusal is the
  // guard working, and it must not page anyone.
  console.warn(`[media] refused image fetch (${reason}): ${url}`)
  return null
}

/**
 * Resolves the hostname and applies the same range rules to every answer.
 *
 * This closes the "public name, private address" hole — `internal.example.com A
 * 10.0.0.5` passes every literal check there is. It does **not** close DNS
 * rebinding: between this lookup and the socket that undici opens, the name is
 * resolved a second time, and a hostile resolver can answer differently. Closing
 * that needs the connection pinned to the address checked here, which for https
 * means either presenting the IP as the host (breaking certificate validation)
 * or a custom undici dispatcher with its own `lookup`. The residual window is
 * accepted deliberately: the attacker must already control DNS for a name an
 * admin pasted, every answer that is *stably* private is refused here, and the
 * blast radius is one image embedded in one PDF rather than an exfiltration
 * channel — the response body is never echoed back, only decoded as an image or
 * discarded.
 */
async function resolvesPublicly(hostname: string, url: string): Promise<boolean> {
  let answers: Array<{ address: string }>
  try {
    answers = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    refuse(url, 'host does not resolve')
    return false
  }

  if (answers.length === 0) {
    refuse(url, 'host resolved to nothing')
    return false
  }

  // *Every* answer must be public, not merely the first: a name that returns
  // both 93.184.216.34 and 127.0.0.1 is a name whose next connection may well
  // pick the second one.
  const blocked = answers.find((answer) => isBlockedAddress(answer.address))
  if (blocked) {
    refuse(url, `host resolves to ${blocked.address}`)
    return false
  }

  return true
}

/**
 * Fetches one image URL through the guard. Returns null for a blank/absent URL
 * and for every kind of failure.
 */
export async function fetchGuardedImage(raw: string | null | undefined): Promise<FetchedImage | null> {
  if (!raw || raw.trim() === '') return null

  const verdict = checkImageUrl(raw)
  if (!verdict.ok) return refuse(raw, verdict.reason)

  const { url, hostname, hostIsAddress } = verdict

  // An IP literal was already range-checked by `checkImageUrl`; there is no name
  // to resolve and nothing a lookup could add.
  if (!hostIsAddress && !(await resolvesPublicly(hostname, url))) return null

  let response: Response
  try {
    response = await fetch(url, {
      // Refused outright rather than followed. Following means re-running the
      // whole guard on each hop and getting the loop, the count and the
      // cross-scheme cases right; refusing means an admin whose CDN redirects
      // has to paste the final URL, which is a smaller cost than a subtly
      // wrong redirect chain that ends at 169.254.169.254.
      redirect: 'manual',
      headers: { Accept: 'image/*' },
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
      cache: 'no-store'
    })
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'unreachable'
    return refuse(url, reason)
  }

  if (response.status >= 300 && response.status < 400) {
    discard(response.body)
    return refuse(url, `redirected (${response.status}); paste the final image URL instead`)
  }
  if (!response.ok) {
    discard(response.body)
    return refuse(url, `HTTP ${response.status}`)
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!contentType.startsWith('image/')) {
    discard(response.body)
    return refuse(url, `not an image (${contentType || 'no content-type'})`)
  }
  if (contentType === 'image/svg+xml') {
    // SVG is a document format, not a bitmap: it can carry script and external
    // references, no PDF renderer here decodes it, and an <img> would render it
    // with the page's privileges. Nothing needs it.
    discard(response.body)
    return refuse(url, 'SVG is not accepted; use PNG or JPEG')
  }

  // Trust the header only to fail fast — never to decide the body is small.
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    discard(response.body)
    return refuse(url, `declares ${declared} bytes, over the ${MAX_IMAGE_BYTES}-byte cap`)
  }

  const body = response.body
  if (!body) return refuse(url, 'empty response')

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_IMAGE_BYTES) {
        discard(reader)
        return refuse(url, `body exceeded the ${MAX_IMAGE_BYTES}-byte cap`)
      }
      chunks.push(value)
    }
  } catch (error) {
    discard(reader)
    // The timeout signal fires at this stage too, not only on the headers: a
    // slowloris host that answers in 40ms and then dribbles the body aborts
    // here. Calling that 'transfer failed' sent an admin looking for a broken
    // CDN when the answer was "it is too slow", so the label distinguishes them.
    const aborted =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return refuse(url, aborted ? 'timed out' : 'transfer failed')
  }

  if (total === 0) return refuse(url, 'zero-length body')

  return { bytes: Buffer.concat(chunks), contentType }
}

/**
 * Fetches several URLs at once — the whole document's imagery in one round of
 * concurrency, before any rendering starts, because @react-pdf's render is
 * synchronous and must never reach out to the network itself.
 *
 * Keys are preserved so a caller reads `images.hero` rather than counting
 * positions; a key whose fetch failed is simply null.
 */
export async function fetchGuardedImages<K extends string>(
  urls: Record<K, string | null | undefined>
): Promise<Record<K, FetchedImage | null>> {
  const keys = Object.keys(urls) as K[]
  const results = await Promise.all(keys.map((key) => fetchGuardedImage(urls[key])))
  return Object.fromEntries(keys.map((key, index) => [key, results[index]])) as Record<
    K,
    FetchedImage | null
  >
}

/** The PNG eight-byte signature, per the spec's §5.2. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** SOI plus the first marker byte of the segment that always follows it. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

/**
 * What format these bytes actually are — read from the bytes, not from the
 * header the host sent.
 *
 * `Content-Type` is a claim, and a wrong one has a specific, bad consequence
 * here: @react-pdf hands a buffer to whichever decoder the format names, and a
 * decoder given the wrong bytes produces an *empty box* on the masthead rather
 * than an error. So a CDN serving a truncated JPEG, or an HTML error page, as
 * `image/png` silently defeated the initials placeholder in precisely the case
 * the placeholder exists for. Sniffing the magic bytes also means a host that
 * mislabels a genuine JPEG as `image/png` embeds correctly, which is the other
 * half of the point: the bytes are the truth either way.
 *
 * Two signatures and no more. Anything else — WebP, AVIF, TIFF, HTML, a
 * zero-padded buffer — is not embeddable, and null means "print the
 * placeholder".
 */
function sniffPdfImageFormat(bytes: Buffer): PdfImage['format'] | null {
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'png'
  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'jpg'
  return null
}

/**
 * Narrows a fetched image to something @react-pdf can decode, applying the
 * document-size cap. Returns null — meaning "print the placeholder" — for a
 * format it cannot embed (WebP, AVIF, TIFF) or an image too heavy to send to a
 * buyer on mobile data.
 */
export function toPdfImage(image: FetchedImage | null): PdfImage | null {
  if (!image) return null

  const format = sniffPdfImageFormat(image.bytes)
  if (!format) {
    // The declared type is in the message because it is the diagnosis: "says
    // image/png" next to "is not PNG" tells an admin their CDN is lying, which
    // is a different fix from "your logo is a WebP".
    console.warn(
      `[media] not embedding ${image.bytes.byteLength} bytes declared ${image.contentType}: ` +
        'the bytes are neither PNG nor JPEG, which are the only formats a PDF here carries'
    )
    return null
  }

  if (image.bytes.byteLength > MAX_PDF_IMAGE_BYTES) {
    console.warn(
      `[media] not embedding a ${image.bytes.byteLength}-byte image: over the ` +
        `${MAX_PDF_IMAGE_BYTES}-byte document budget. Upload a smaller version.`
    )
    return null
  }

  return { data: image.bytes, format }
}

/** `fetchGuardedImage` + `toPdfImage`, which is what every PDF caller wants. */
export async function fetchPdfImage(raw: string | null | undefined): Promise<PdfImage | null> {
  return toPdfImage(await fetchGuardedImage(raw))
}
