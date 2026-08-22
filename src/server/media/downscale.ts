import sharp from 'sharp'
import type { UploadKind } from '@/domain/uploads'
import { MAX_PDF_IMAGE_BYTES } from '@/server/media/images'
import { ServiceError } from '@/server/services/errors'

/**
 * Turning whatever an admin picked into something a buyer can actually load.
 *
 * The file on a developer's laptop is a 6MB brochure export, a 4000px camera
 * JPEG or a floor plan rasterised at print resolution. Storing it as-is would
 * make the sale page a 6MB page load for someone on a metered connection in
 * Lagos, and would silently defeat the PDF pipeline, which refuses to embed
 * anything over `MAX_PDF_IMAGE_BYTES` and prints the placeholder instead. So
 * every upload is resized and re-encoded before it is stored, and what lands in
 * the column is a URL to the processed image — never the original.
 *
 * Three deliberate decisions live here.
 *
 * **JPEG and PNG only, never WebP.** WebP is smaller and every browser this app
 * targets renders it, so it is the obvious choice for the web — and it is the
 * wrong one, because the same URLs are fetched back by `@/server/media/images`
 * and embedded in invoices, receipts and statements, and `toPdfImage` embeds
 * PNG and JPEG and nothing else. Storing WebP would mean an admin uploads a
 * logo, sees it on /team, and then finds every invoice still printing the
 * initials placeholder with no error anywhere. The page-weight difference is
 * tens of kilobytes; the correctness difference is the entire feature.
 *
 * **A byte budget, not just a pixel cap.** A 2000px cap says nothing about file
 * size — a detailed photo at 2000px can still be 2MB. Each profile names the
 * number of bytes it is willing to spend and the encoder walks down a ladder of
 * quality settings (and then of dimensions) until it fits. The hero's budget is
 * exactly `MAX_PDF_IMAGE_BYTES`, so a photo that renders on the page is by
 * construction a photo that also embeds in the statement.
 *
 * **Metadata is dropped.** sharp emits no EXIF unless asked, and it is not
 * asked: a photograph taken on a phone at a construction site carries GPS
 * coordinates, and this store is public.
 */

/** What comes out: processed bytes, and the two facts the caller needs to store them. */
export interface EncodedImage {
  bytes: Buffer
  extension: 'jpg' | 'png'
  contentType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  /** For the log line and the report: how much was saved, and from what. */
  originalBytes: number
}

interface Candidate {
  format: 'jpeg' | 'png'
  quality: number
  /**
   * PNG only. libimagequant palette reduction — for line art (a floor plan is
   * mostly white with thin black strokes and small text) this is both smaller
   * *and* sharper than any JPEG, because JPEG's 8×8 blocks ring around exactly
   * the high-contrast edges a plan is made of.
   */
  palette?: boolean
}

interface Profile {
  /** Cap on the long edge, in pixels. */
  maxEdge: number
  /** What this slot is allowed to weigh once encoded. */
  budgetBytes: number
  /** Tried in order; the first result inside the budget wins. */
  ladder: Candidate[]
}

/**
 * One profile per slot, because the four are genuinely different pictures.
 *
 * `layout` gets the largest edge (2400) and the PNG-first ladder: a floor plan
 * carries fine linework and room labels a buyer needs to read, and 2000px of a
 * JPEG'd plan is a plan whose dimensions you cannot make out. Everything else is
 * a photograph, where JPEG is both smaller and visually better.
 *
 * `logo` is small on purpose — it is drawn at 128px on /team and at 46pt in a
 * PDF masthead — and PNG-first because a mark usually has a transparent
 * background and flattening one onto white is a visible change to somebody's
 * brand.
 */
export const IMAGE_PROFILES: Record<UploadKind, Profile> = {
  building: {
    maxEdge: 2000,
    // Exactly the PDF budget: the hero prints in the statement's band, so an
    // image that passes here is an image that embeds there.
    budgetBytes: MAX_PDF_IMAGE_BYTES,
    ladder: [
      { format: 'jpeg', quality: 82 },
      { format: 'jpeg', quality: 72 },
      { format: 'jpeg', quality: 62 }
    ]
  },
  render: {
    maxEdge: 2000,
    // Renders never enter a PDF, only the web gallery — so a little more room
    // than the hero, and still a quarter of what "well under 1MB" asks for.
    budgetBytes: 250 * 1024,
    ladder: [
      { format: 'jpeg', quality: 82 },
      { format: 'jpeg', quality: 72 },
      { format: 'jpeg', quality: 62 }
    ]
  },
  gallery: {
    maxEdge: 2000,
    // An amenity photograph — the gym, the pool, the lobby. Web only, like a
    // render and unlike the hero, so it gets the same headroom rather than the
    // tighter PDF-embed budget. A buyer may scroll past a dozen of these on a
    // phone, which is the reason not to be more generous than a render.
    budgetBytes: 250 * 1024,
    ladder: [
      { format: 'jpeg', quality: 82 },
      { format: 'jpeg', quality: 72 },
      { format: 'jpeg', quality: 62 }
    ]
  },
  layout: {
    maxEdge: 2400,
    // The PDF budget, for the same reason `building` carries it: the plan now
    // prints in a document of its own, so an image that passes here has to be
    // an image that embeds there. It used to be 400 kB, which was 400 kB of a
    // slot nothing outside the browser read — and the moment the floor plan PDF
    // existed, that gap became a silent failure with the worst possible shape:
    // the architect's real drawing for the owner's own building stores at
    // 348 kB, `toPdfImage` refuses anything over 300 kB, and the document a
    // buyer downloaded then said no plan had been uploaded for a unit that had
    // one. Better a slightly harder-compressed plan everywhere than a plan that
    // is only in the browser.
    //
    // The ladder below still tries both PNGs at full size first, so a plan that
    // fits as PNG stays a PNG; a dense one now lands on JPEG at 1800px rather
    // than PNG at 1800px, which is a format change and not a resolution one —
    // about 240dpi across an A4 page, with the linework still legible.
    budgetBytes: MAX_PDF_IMAGE_BYTES,
    ladder: [
      { format: 'png', quality: 90, palette: true },
      { format: 'png', quality: 70, palette: true },
      { format: 'jpeg', quality: 88 },
      { format: 'jpeg', quality: 78 }
    ]
  },
  logo: {
    maxEdge: 512,
    budgetBytes: 120 * 1024,
    ladder: [
      { format: 'png', quality: 90, palette: true },
      { format: 'png', quality: 60, palette: true },
      { format: 'jpeg', quality: 85 }
    ]
  }
}

const CONTENT_TYPE = { jpeg: 'image/jpeg', png: 'image/png' } as const
const EXTENSION = { jpeg: 'jpg', png: 'png' } as const

/**
 * The dimension steps tried, as fractions of the profile's cap. Only reached
 * when the whole quality ladder is still over budget at full size — a very
 * large, very busy photograph. Shrinking beats crushing quality to 40 for the
 * same bytes: a smaller sharp image reads better than a big smeared one.
 */
const EDGE_STEPS = [1, 0.75, 0.5]

async function encodeAt(
  input: Buffer,
  edge: number,
  candidate: Candidate
): Promise<{ bytes: Buffer; width: number; height: number }> {
  // `failOn: 'none'` — a slightly truncated JPEG out of a phone gallery is
  // still an image a buyer would want on the page, and the magic-byte check has
  // already established this is not an HTML page in disguise. sharp still
  // throws for a buffer it cannot decode at all, which is what the caller
  // catches.
  let pipeline = sharp(input, { failOn: 'none' })
    // Applies (and then discards) the EXIF orientation tag. Without it a photo
    // taken in portrait on a phone stores sideways, because the pixels are
    // landscape and only the tag says otherwise — and the tag is stripped.
    .rotate()
    .resize({
      width: edge,
      height: edge,
      fit: 'inside',
      // The half of this that makes "a small image is not upscaled" true: a
      // 400px logo stays 400px rather than being blown up to 512 and stored
      // larger and blurrier than it arrived.
      withoutEnlargement: true
    })

  if (candidate.format === 'jpeg') {
    // Transparency has to go somewhere in a JPEG, and sharp's default is
    // black — which turns a transparent-background logo into a black slab.
    // White is what every surface it appears on is drawn in.
    pipeline = pipeline
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: candidate.quality, mozjpeg: true, chromaSubsampling: '4:4:4' })
  } else {
    pipeline = pipeline.png({
      quality: candidate.quality,
      palette: candidate.palette ?? false,
      compressionLevel: 9
    })
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
  return { bytes: data, width: info.width, height: info.height }
}

/**
 * Resize and re-encode one uploaded image for the slot it is going into.
 *
 * Walks dimensions outermost and quality innermost, returning the first result
 * inside the profile's budget. If nothing fits — a pathological input — the
 * smallest result produced is returned rather than a failure: a slightly
 * over-budget photo on the page is a better outcome for the admin who just
 * waited for an upload than an error, and the PDF path independently refuses
 * anything over its own cap and prints the placeholder.
 *
 * Throws a `ServiceError` for a buffer sharp cannot decode. The caller has
 * already checked the magic bytes, so this is the "genuine PNG signature,
 * corrupt afterwards" case.
 */
export async function downscaleImage(input: Buffer, kind: UploadKind): Promise<EncodedImage> {
  const profile = IMAGE_PROFILES[kind]
  let best: { bytes: Buffer; width: number; height: number; candidate: Candidate } | null = null

  for (const step of EDGE_STEPS) {
    const edge = Math.max(64, Math.round(profile.maxEdge * step))

    for (const candidate of profile.ladder) {
      let encoded
      try {
        encoded = await encodeAt(input, edge, candidate)
      } catch (error) {
        // One decode failure means every attempt will fail the same way — the
        // input is what is broken, not the settings.
        throw new ServiceError(
          `That image could not be read (${
            error instanceof Error ? error.message : 'unknown error'
          }). Try exporting it again as a PNG or JPEG.`,
          'VALIDATION'
        )
      }

      if (encoded.bytes.byteLength <= profile.budgetBytes) {
        return finish(encoded, candidate, input.byteLength)
      }
      if (!best || encoded.bytes.byteLength < best.bytes.byteLength) {
        best = { ...encoded, candidate }
      }
    }
  }

  // Unreachable in practice — EDGE_STEPS is non-empty and every ladder has at
  // least one entry, so `best` is always set by the first iteration.
  /* c8 ignore next */
  if (!best) throw new ServiceError('That image could not be processed.', 'VALIDATION')

  console.warn(
    `[uploads] ${kind}: smallest encoding is ${best.bytes.byteLength} bytes, over the ` +
      `${profile.budgetBytes}-byte budget. Stored anyway at ${best.width}×${best.height}.`
  )
  return finish(best, best.candidate, input.byteLength)
}

function finish(
  encoded: { bytes: Buffer; width: number; height: number },
  candidate: Candidate,
  originalBytes: number
): EncodedImage {
  return {
    bytes: encoded.bytes,
    extension: EXTENSION[candidate.format],
    contentType: CONTENT_TYPE[candidate.format],
    width: encoded.width,
    height: encoded.height,
    originalBytes
  }
}
