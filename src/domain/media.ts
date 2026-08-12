/**
 * The one place that decides whether a URL an admin pasted may be fetched by
 * this server.
 *
 * Imagery is supplied as pasted `https` URLs — there is no upload pipeline and
 * no blob storage — and the PDFs have to embed those images, which means the
 * server issues a request to an address a user chose. That is server-side
 * request forgery: `http://169.254.169.254/latest/meta-data/` makes the server
 * read its own cloud credentials, `http://localhost:5432` makes it probe the
 * database port, and either response would then be baked into a PDF the user
 * downloads. So the decision is made once, here, in a pure module with no I/O,
 * and everything that fetches goes through it:
 *
 *   - `checkImageUrl` is the whole verdict for a URL whose host is a literal
 *     address, and the first half of the verdict for a hostname. It runs at
 *     input time too, so an admin gets an immediate form error instead of a
 *     silently broken image weeks later.
 *   - `isBlockedAddress` is exported separately because a hostname can *resolve*
 *     to a private address — `internal.example.com A 10.0.0.5` passes every
 *     literal check there is. The server-side fetch wrapper resolves the host
 *     and runs each answer through this same function, so the range rules are
 *     written down once rather than twice.
 *
 * Pure on purpose: DNS lives in `@/server/media/images`, because a guard that
 * cannot be called without a network is a guard that does not get tested.
 */

/** Renders per unit. A paste accident must not put 400 images on a page. */
export const MAX_RENDER_IMAGES = 8

/** Long enough for a signed CDN URL, short enough to keep a form field sane. */
export const MAX_IMAGE_URL_LENGTH = 2048

export interface ImageUrlAccepted {
  ok: true
  /** Normalised (`URL.toString()`) — this is what gets stored and rendered. */
  url: string
  /** Lower-cased, brackets and any trailing dot stripped. Ready for DNS. */
  hostname: string
  /**
   * True when the host is an IP literal, which `checkImageUrl` has already
   * range-checked. The fetch wrapper skips resolution for these: there is no
   * name to look up, and nothing a later lookup could add.
   */
  hostIsAddress: boolean
}

export interface ImageUrlRejected {
  ok: false
  /** Shown to the admin who pasted it, so it says what to do about it. */
  reason: string
}

export type ImageUrlVerdict = ImageUrlAccepted | ImageUrlRejected

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa']
const BLOCKED_HOSTS = ['localhost', 'ip6-localhost', 'ip6-loopback']

/**
 * Parses dotted-quad IPv4 and nothing else. Deliberately strict: no octal
 * (`0177.0.0.1`), no decimal (`2130706433`), no short forms (`10.1`) — all of
 * which browsers and `inet_aton` accept as loopback or private addresses and
 * all of which a naive `split('.')` check waves through. Anything that is not
 * exactly four plain decimal octets is not an IPv4 literal as far as this
 * module is concerned, and therefore falls to the hostname path, where DNS
 * resolution catches it: Node's resolver applies the same strictness, so
 * `0177.0.0.1` either fails to resolve or resolves to an address that
 * `isBlockedAddress` then judges on its merits.
 */
function parseIPv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null

  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

/**
 * Expands an IPv6 literal to its eight hextets, handling `::` compression and
 * a trailing embedded IPv4 (`::ffff:10.0.0.1`, which is how an IPv4-mapped
 * address reaches a dual-stack socket). Returns null for anything malformed —
 * and a malformed host is rejected by the caller rather than assumed safe.
 */
function parseIPv6(host: string): number[] | null {
  if (!host.includes(':')) return null

  let text = host
  const embedded: number[] = []

  // A trailing dotted-quad supplies the last two hextets.
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const quad = parseIPv4(tail)
    if (!quad) return null
    embedded.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3])
    text = text.slice(0, lastColon + 1) + '0'
  }

  const doubleColon = text.indexOf('::')
  if (doubleColon !== text.lastIndexOf('::')) return null // at most one `::`

  const hextet = (piece: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
    return parseInt(piece, 16)
  }

  const readGroups = (segment: string): number[] | null => {
    if (segment === '') return []
    const groups: number[] = []
    for (const piece of segment.split(':')) {
      const value = hextet(piece)
      if (value === null) return null
      groups.push(value)
    }
    return groups
  }

  let head: number[]
  let rest: number[]
  if (doubleColon >= 0) {
    const left = readGroups(text.slice(0, doubleColon))
    const right = readGroups(text.slice(doubleColon + 2))
    if (!left || !right) return null
    head = left
    rest = right
  } else {
    const all = readGroups(text)
    if (!all) return null
    head = all
    rest = []
  }

  // The `0` substituted for the embedded quad above is a placeholder that the
  // two real hextets replace.
  if (embedded.length) {
    if (rest.length) rest = [...rest.slice(0, -1), ...embedded]
    else head = [...head.slice(0, -1), ...embedded]
  }

  const filled = head.length + rest.length
  if (doubleColon < 0) return filled === 8 ? head : null
  if (filled > 7) return null // `::` must stand for at least one hextet
  return [...head, ...Array(8 - filled).fill(0), ...rest]
}

/** True when the host is an IP literal in any form this module recognises. */
export function isAddressLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null
}

/**
 * The range rules, applied to one address — whether it came out of the URL as a
 * literal or out of a DNS answer. Blocks loopback, link-local (the cloud
 * metadata endpoint lives at 169.254.169.254), RFC1918 private space,
 * unique-local IPv6, the unspecified addresses, carrier-grade NAT, and
 * multicast/reserved space. Anything unparseable is blocked too: a guard that
 * cannot classify an address must not wave it through.
 */
export function isBlockedAddress(address: string): boolean {
  const host = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]

  const v4 = parseIPv4(host)
  if (v4) return isBlockedIPv4(v4)

  const v6 = parseIPv6(host)
  if (v6) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses
    // reach an IPv4 destination, so they are judged by the IPv4 rules —
    // otherwise ::ffff:169.254.169.254 is a hole straight through them.
    const mapped = v6.slice(0, 5).every((h) => h === 0)
    if (mapped && (v6[5] === 0xffff || v6[5] === 0)) {
      const embedded = [v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff]
      // `::` and `::1` themselves are handled below, not as 0.0.0.0/0.0.0.1.
      if (!(v6[5] === 0 && v6[6] === 0 && v6[7] <= 1)) return isBlockedIPv4(embedded)
    }

    if (v6.every((h) => h === 0)) return true // ::  (unspecified)
    if (v6.slice(0, 7).every((h) => h === 0) && v6[7] === 1) return true // ::1 loopback
    if ((v6[0] & 0xfe00) === 0xfc00) return true // fc00::/7  unique-local
    if ((v6[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((v6[0] & 0xff00) === 0xff00) return true // ff00::/8  multicast
    return false
  }

  return true
}

function isBlockedIPv4(o: number[]): boolean {
  if (o[0] === 0) return true // 0.0.0.0/8      "this network", incl. 0.0.0.0
  if (o[0] === 10) return true // 10.0.0.0/8    private
  if (o[0] === 127) return true // 127.0.0.0/8  loopback
  if (o[0] === 169 && o[1] === 254) return true // 169.254.0.0/16 link-local (metadata)
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true // 172.16.0.0/12 private
  if (o[0] === 192 && o[1] === 168) return true // 192.168.0.0/16 private
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true // 100.64.0.0/10 CGNAT
  if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true // 192.0.0.0/24 protocol assignments
  if (o[0] >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false
}

/**
 * The verdict on one pasted URL. `https` only, no private or loopback
 * destination, no host that names something on this machine or this network.
 *
 * A hostname that passes here is not yet cleared to be fetched — see
 * `isBlockedAddress` and the fetch wrapper, which resolve it first.
 */
export function checkImageUrl(raw: string): ImageUrlVerdict {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: 'Enter an image URL, or leave the field empty.' }
  if (trimmed.length > MAX_IMAGE_URL_LENGTH) {
    return { ok: false, reason: `An image URL cannot exceed ${MAX_IMAGE_URL_LENGTH} characters.` }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'That is not a valid URL. Paste the full address, starting https://' }
  }

  if (url.protocol !== 'https:') {
    // Named rather than lumped in with "invalid": data: and file: are the two
    // people reach for by accident, and http: is the one they reach for on
    // purpose. Each deserves an answer that says what to do instead.
    return {
      ok: false,
      reason: `Image URLs must start with https:// — "${url.protocol}" is not accepted.`
    }
  }

  // Credentials in the URL are a smell (and a way to smuggle a host past a
  // careless parser); nothing legitimate needs them for a public image.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'Image URLs must not contain a username or password.' }
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (hostname === '') return { ok: false, reason: 'That URL has no host.' }

  if (BLOCKED_HOSTS.includes(hostname) || BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    return {
      ok: false,
      reason: 'That address points at this machine or a local network name. Use a public image URL.'
    }
  }

  const hostIsAddress = isAddressLiteral(hostname)
  if (hostIsAddress && isBlockedAddress(hostname)) {
    return {
      ok: false,
      reason: 'That address is on a private or loopback network. Use a public image URL.'
    }
  }

  return { ok: true, url: url.toString(), hostname, hostIsAddress }
}

/** Convenience for schemas and callers that only need "is this usable". */
export function isFetchableImageUrl(raw: string): boolean {
  return checkImageUrl(raw).ok
}

export type RenderUrlsVerdict =
  | { ok: true; urls: string[] }
  | { ok: false; reason: string }

/**
 * The renders textarea: one URL per line. Blank lines and stray whitespace are
 * the normal result of pasting from a spreadsheet, so they are dropped rather
 * than rejected; a line that is actually a bad URL is rejected by line number,
 * because "one of your eight URLs is wrong" is not an actionable error message.
 * Duplicates collapse to the first occurrence — the same render twice is a
 * paste slip, not a gallery.
 */
export function parseRenderUrls(raw: string): RenderUrlsVerdict {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const urls: string[] = []
  for (const [index, line] of lines.entries()) {
    const verdict = checkImageUrl(line)
    if (!verdict.ok) return { ok: false, reason: `Line ${index + 1}: ${verdict.reason}` }
    if (!urls.includes(verdict.url)) urls.push(verdict.url)
  }

  // Counted after de-duplication, so pasting the same URL nine times is not an
  // error — but nine different ones is, and the count is checked before any of
  // them is stored rather than after a page has to render them.
  if (urls.length > MAX_RENDER_IMAGES) {
    return {
      ok: false,
      reason: `A unit can carry at most ${MAX_RENDER_IMAGES} renders — that is ${urls.length}.`
    }
  }

  return { ok: true, urls }
}
