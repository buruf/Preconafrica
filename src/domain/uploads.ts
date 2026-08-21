/**
 * Everything about an *uploaded* image that can be decided without touching the
 * outside world: what the bytes actually are, how big they may be, where they
 * are stored, and — when one replaces another — whether the old one is ours to
 * delete.
 *
 * Pure, for the same reason `@/domain/media` is pure: these are the rules that
 * decide whether a file is accepted at all, and a rule that needs a network, a
 * disk or a Blob token to exercise is a rule that does not get tested. The parts
 * that need the world live in `@/server/media/*`:
 *
 *   - `@/server/media/downscale` re-encodes (sharp),
 *   - `@/server/media/blob` writes and deletes (Vercel Blob),
 *   - `@/server/services/uploads` puts the two together behind an admin guard.
 *
 * Note the division of labour against `@/domain/media`: that module guards URLs
 * an admin *pasted*, because those are fetched by this server and are therefore
 * an SSRF surface. This module guards bytes an admin *uploaded*, which are never
 * fetched from anywhere — the risk there is a file that is not an image at all.
 * Both end in the same place: a URL string in a column, rendered by
 * `MediaImage`, embedded in PDFs through the same guarded fetch as before.
 */

/**
 * The ceiling on an upload, checked before a single byte is decoded.
 *
 * A phone camera export is 3–6MB and a floor plan out of a CAD package can be
 * larger, so the limit is generous — but it is a limit, because `sharp` decoding
 * an arbitrary buffer is the expensive step and a 200MB "image" must be refused
 * by counting, not by trying.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Below this there is nothing to sniff; an empty file is a failed drag, not an image. */
export const MIN_UPLOAD_BYTES = 16

/**
 * The largest body the *platform* will carry, which is a different limit from
 * the one above and much lower.
 *
 * Vercel caps a serverless function's request body at 4.5MB and rejects
 * anything bigger before the route runs at all — so the rejection is not JSON,
 * carries none of this app's error messages, and surfaced to the uploader as a
 * bare "That upload failed. Try again." A photograph taken on a phone is
 * routinely 4–12MB, so this was every real building photo.
 *
 * Set below the cap rather than at it: a multipart body carries field names and
 * boundaries as well as the file, so the file itself has to be comfortably
 * under. `MAX_UPLOAD_BYTES` stays where it is — it is the server's own guard
 * against decoding something absurd, and it is not the binding constraint here.
 */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024

/**
 * The long edge to shrink to in the browser, per slot, mirroring
 * `IMAGE_PROFILES` in server/media/downscale.ts.
 *
 * Duplicated rather than imported because that module pulls in `sharp`, which
 * cannot exist in a browser bundle. The values are the ones the server would
 * downscale to anyway, so sending anything larger is uploading pixels over a
 * phone connection for the server to immediately discard.
 *
 * Kept in the domain layer, beside the other upload rules, so the two are read
 * together the next time either changes.
 */
export const CLIENT_MAX_EDGE: Record<UploadKind, number> = {
  building: 2000,
  render: 2000,
  // Higher, and deliberately: linework and room labels have to stay legible.
  layout: 2400,
  logo: 1000
}

/**
 * Whether the browser should re-encode before uploading.
 *
 * Only when it has to. A file already under the request cap goes up untouched,
 * because re-encoding a small PNG floor plan as JPEG would lose linework to
 * solve a problem it does not have.
 */
export function needsClientDownscale(bytes: number): boolean {
  return bytes > MAX_REQUEST_BYTES
}

/** The bitmap formats a browser will let someone pick and this server can decode. */
export type UploadedImageFormat = 'png' | 'jpeg' | 'webp'

/** The four slots an image can occupy. Each has its own size and encoding profile. */
export type UploadKind = 'building' | 'layout' | 'render' | 'logo'

/** PNG's eight-byte signature, per the spec's §5.2. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** SOI plus the first marker byte of the segment that always follows it. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff]
/** RIFF container, four bytes of length, then the WEBP fourcc. */
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]
const WEBP_FOURCC = [0x57, 0x45, 0x42, 0x50]

function startsWith(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[offset + i] !== magic[i]) return false
  }
  return true
}

/**
 * What these bytes actually are — read from the bytes, never from the
 * `Content-Type` a browser attached or the extension on the filename.
 *
 * This is the one sniffer in the codebase. `@/server/media/images` used to carry
 * a private copy covering PNG and JPEG for the PDF pipeline; it now imports this
 * one, so "what counts as a PNG" is written down exactly once. WebP is here and
 * not there on purpose: a browser uploads WebP happily and it is the best format
 * for a page, but no PDF renderer in this app decodes it — see `toPdfImage`.
 *
 * Anything else is null: HTML renamed `.png`, an SVG (a *document* format that
 * can carry script, and which nothing here needs), a PDF, a zip, a truncated
 * signature, an empty buffer.
 */
export function sniffImageFormat(bytes: Uint8Array): UploadedImageFormat | null {
  if (startsWith(bytes, PNG_MAGIC)) return 'png'
  if (startsWith(bytes, JPEG_MAGIC)) return 'jpeg'
  // RIFF....WEBP — the four length bytes in between are not checked, because a
  // wrong length is sharp's problem to reject, not a reason to call a genuine
  // WebP something else.
  if (startsWith(bytes, RIFF_MAGIC) && startsWith(bytes, WEBP_FOURCC, 8)) return 'webp'
  return null
}

export type UploadVerdict =
  | { ok: true; format: UploadedImageFormat }
  | { ok: false; reason: string }

/**
 * The whole "may these bytes be processed" decision: not empty, not oversize,
 * and actually one of the three formats.
 *
 * Order matters. Size is checked before the sniff so a 200MB upload is refused
 * by its length rather than by anything that has to look inside it, and the
 * emptiness check comes first so a failed drag-and-drop gets "that file is
 * empty" instead of "that is not an image".
 *
 * Every reason is written for the admin who is looking at the form, so it says
 * what to do next rather than what went wrong internally.
 */
export function checkUpload(bytes: Uint8Array): UploadVerdict {
  if (bytes.length === 0) return { ok: false, reason: 'That file is empty.' }
  if (bytes.length < MIN_UPLOAD_BYTES) {
    return { ok: false, reason: 'That file is too small to be an image.' }
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    const mb = Math.round((bytes.length / (1024 * 1024)) * 10) / 10
    return {
      ok: false,
      reason: `That file is ${mb}MB. Images must be under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`
    }
  }

  const format = sniffImageFormat(bytes)
  if (!format) {
    return {
      ok: false,
      reason: 'That file is not a PNG, JPEG or WebP image. Rename does not change the contents.'
    }
  }

  return { ok: true, format }
}

/* ------------------------------------------------------------- blob paths */

/**
 * The host suffix every Vercel Blob store answers on.
 *
 * Deliberately the *shared* part, not `.public.blob.vercel-storage.com`. A store
 * is created in one of two access modes and its base URL says which —
 * `{id}.public.blob.vercel-storage.com` or `{id}.private.blob.vercel-storage.com`
 * — and this app needs a public one, because the URLs it stores are loaded
 * directly by a buyer's browser and fetched server-side for PDF embedding.
 *
 * Matching only the public form would still be *correct* while the store is
 * public, and would fail silently and expensively the day it is not: every
 * previously uploaded image would stop being recognised as ours, so replacing
 * one would quietly orphan it instead of deleting it, forever, with no error.
 * Ownership is a claim about *our* store, and the tenant-prefix half of
 * `isOwnedBlobUrl` is what actually keeps it narrow.
 */
export const BLOB_HOST_SUFFIX = '.blob.vercel-storage.com'

/**
 * Ids only ever come from our own database (cuid) or from a generated token, so
 * this is a tripwire rather than a sanitiser: if something that is not one of
 * those reaches the path builder, the right answer is to stop, not to strip
 * characters and carry on with a path nobody intended.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

export class BlobPathError extends Error {}

function segment(label: string, value: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new BlobPathError(`Unsafe ${label} for a blob path: ${JSON.stringify(value)}`)
  }
  return value
}

export interface BlobPathInput {
  /** The tenant. First segment of every path, so a prefix listing is per-org. */
  orgId: string
  kind: UploadKind
  /** Required for everything but 'logo'. */
  projectId?: string
  /**
   * Required for 'render'. Optional for 'layout': a drawing that covers several
   * units is stored under the project instead.
   */
  unitId?: string
  /** Random, generated server-side. Never anything the uploader supplied. */
  token: string
  /** 'jpg' or 'png' — decided by the encoder, not by what was uploaded. */
  extension: 'jpg' | 'png'
}

/**
 * Where an uploaded image lives in the store.
 *
 *   org/{orgId}/logo-{token}.png
 *   org/{orgId}/project/{projectId}/hero-{token}.jpg
 *   org/{orgId}/project/{projectId}/layout-{token}.jpg          (shared plan)
 *   org/{orgId}/project/{projectId}/unit/{unitId}/layout-{token}.jpg
 *   org/{orgId}/project/{projectId}/unit/{unitId}/render-{token}.jpg
 *
 * Two properties this shape exists for, both pinned by tests:
 *
 *  1. **The tenant is the first segment.** That is what makes
 *     `isOwnedBlobUrl` below able to answer "may this org delete this blob?"
 *     from the URL alone, without a database read, and it means a store
 *     listing is sorted by tenant rather than interleaved.
 *  2. **Nothing the uploader supplied appears in it.** Not the filename, not
 *     the extension they typed, not the declared MIME type. A filename is
 *     attacker-controlled text that would end up in a public URL, and a name
 *     like `../../other-org/logo.png` or a 300-character unicode string is a
 *     problem nobody should have to think about twice. The name is thrown away
 *     at the door and the path is derived from the slot it is filling.
 */
export function blobPathFor(input: BlobPathInput): string {
  const org = `org/${segment('orgId', input.orgId)}`
  const token = segment('token', input.token)
  const ext = input.extension

  if (input.kind === 'logo') return `${org}/logo-${token}.${ext}`

  if (!input.projectId) throw new BlobPathError(`A ${input.kind} image needs a projectId`)
  const project = `${org}/project/${segment('projectId', input.projectId)}`

  if (input.kind === 'building') return `${project}/hero-${token}.${ext}`

  // A layout without a unit is a drawing shared by several of them — the PDF
  // importer uploads one page for every 3-bedroom unit at once. It belongs to
  // the project, and storing it under any one of the units it covers would put
  // a misleading id in a public URL. A render always names its unit.
  if (input.kind === 'layout' && !input.unitId) return `${project}/layout-${token}.${ext}`

  if (!input.unitId) throw new BlobPathError(`A ${input.kind} image needs a unitId`)
  const unit = `${project}/unit/${segment('unitId', input.unitId)}`
  return `${unit}/${input.kind}-${token}.${ext}`
}

/* ------------------------------------------------- ours, or someone else's */

/**
 * Is this URL a blob in *a* Vercel Blob store?
 *
 * Deliberately narrow: `https`, and a host that ends in the Blob suffix. A URL
 * that merely contains the suffix somewhere (`https://evil.com/?x=.public.blob.vercel-storage.com`)
 * is not one, which is why this parses the URL rather than searching the string.
 */
export function isManagedBlobUrl(raw: string | null | undefined): boolean {
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  return url.hostname.toLowerCase().endsWith(BLOB_HOST_SUFFIX)
}

/**
 * May this organisation delete this URL?
 *
 * The question behind every "replace the photo" and every Remove: the old value
 * has to go, or the store grows forever — but only if it was ours to begin
 * with. An admin who pasted `https://developer-partner.example/tower.jpg` and
 * then uploads a real photo must not have us issue a delete against somebody
 * else's asset, and the fact that we cannot delete it is beside the point; the
 * intent must not be in the code.
 *
 * Two conditions, and both are necessary:
 *
 *  - it is a Blob URL at all (`isManagedBlobUrl`), which excludes every pasted
 *    external link; and
 *  - its path begins `org/{orgId}/`, which excludes *another tenant's* blob.
 *    Without the second test, an admin could paste a rival org's blob URL into
 *    their own logo field, save, then replace it — and we would cheerfully
 *    delete an image belonging to someone else. It is a one-line predicate
 *    guarding a cross-tenant destructive write, so it is written down here with
 *    a test rather than assumed at each call site.
 */
export function isOwnedBlobUrl(raw: string | null | undefined, orgId: string): boolean {
  if (!isManagedBlobUrl(raw)) return false
  if (!SAFE_SEGMENT.test(orgId)) return false

  // `raw` parsed cleanly inside isManagedBlobUrl, so this cannot throw.
  const url = new URL((raw as string).trim())
  // `pathname` is percent-encoded and always leading-slashed; the prefix we
  // build has no characters that encode, so a plain comparison is exact.
  return url.pathname.startsWith(`/org/${orgId}/`)
}

/**
 * The pathname a `del()` needs, or null when the URL is not ours to delete.
 * One function so no caller can decide "ours" one way and derive the key
 * another.
 */
export function ownedBlobPathname(raw: string | null | undefined, orgId: string): string | null {
  if (!isOwnedBlobUrl(raw, orgId)) return null
  return new URL((raw as string).trim()).pathname.replace(/^\//, '')
}
