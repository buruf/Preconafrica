import { z } from 'zod'
import {
  MAX_IMAGE_URL_LENGTH,
  MAX_RENDER_IMAGES,
  checkImageUrl,
  parseRenderUrls
} from '@/domain/media'

export { MAX_RENDER_IMAGES }

/**
 * The form-facing half of the image-URL guard: the same pure `checkImageUrl`
 * that the server-side fetch runs, wired into zod so an admin who pastes
 * `http://localhost:5432` is told at the form rather than discovering weeks
 * later that one page shows a placeholder and nobody knows why.
 *
 * Parses to `string | null`, never `undefined` and never `''`:
 *
 *   - a URL that passes becomes its normalised form (`URL.toString()`), which is
 *     what gets stored and what a page renders;
 *   - an empty field becomes `null`, which is how a URL is *cleared*. Storing
 *     `''` would leave a falsy value in the column that every display site would
 *     have to remember to treat as unset — and one of them would forget.
 *
 * Callers that patch (rather than create) wrap this in `.optional()`, so an
 * absent field means "leave it alone" and a present-but-empty one means "clear
 * it". That distinction has to survive the FormData read too — see
 * `imageFieldFrom` below.
 */
export const ImageUrlField = z
  .string()
  .max(MAX_IMAGE_URL_LENGTH, `An image URL cannot exceed ${MAX_IMAGE_URL_LENGTH} characters.`)
  .transform((raw, ctx) => {
    const value = raw.trim()
    if (value === '') return null

    const verdict = checkImageUrl(value)
    if (!verdict.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: verdict.reason })
      return z.NEVER
    }
    return verdict.url
  })

/**
 * The renders textarea: one URL per line, parsed by the pure `parseRenderUrls`
 * (trims, drops blanks, de-duplicates, rejects a bad line by number, caps the
 * count). An empty textarea parses to `[]`, which clears the list — the
 * array-shaped counterpart of `ImageUrlField`'s null.
 */
export const RenderUrlsField = z
  .string()
  .max(MAX_RENDER_IMAGES * (MAX_IMAGE_URL_LENGTH + 2), 'That is too much text for this field.')
  .transform((raw, ctx) => {
    const parsed = parseRenderUrls(raw)
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.reason })
      return z.NEVER
    }
    return parsed.urls
  })

/**
 * Reads one image field out of a FormData, preserving the difference between
 * "the form did not carry this field" (undefined — do not touch the column) and
 * "the form carried it empty" (empty string — clear the column).
 *
 * The existing `formData.get(x) || undefined` idiom cannot express that: it
 * collapses a deliberately-cleared field into "unchanged", so an admin who
 * emptied the box would find the old URL still there on reload.
 */
export function imageFieldFrom(formData: FormData, name: string): string | undefined {
  return formData.has(name) ? String(formData.get(name) ?? '') : undefined
}
