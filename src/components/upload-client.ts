import {
  CLIENT_MAX_EDGE,
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  needsClientDownscale,
  type UploadKind
} from '@/domain/uploads'

/**
 * The browser half of an upload, shared by every control that performs one:
 * the image picker on a project or a unit, and the PDF importer that uploads a
 * rendered page.
 *
 * One copy, so the size pre-check and — more importantly — the habit of
 * surfacing the *server's* own sentence rather than a generic failure cannot
 * drift between callers.
 */

export interface UploadTarget {
  uploadKind: UploadKind
  projectId?: string
  unitId?: string
}

/**
 * One file to the upload route, one URL back.
 *
 * The size check here is a courtesy, not the guard: the browser knows the size
 * without a round trip, so telling someone their 40MB TIFF is too big should not
 * cost them a 40MB upload first. The server checks the declared size *and* then
 * the real buffer, and sniffs the magic bytes, because none of this is
 * trustworthy.
 */
export async function uploadOne(file: File, target: UploadTarget): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `"${file.name}" is ${Math.round((file.size / (1024 * 1024)) * 10) / 10}MB. ` +
        `Images must be under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`
    )
  }

  // Shrunk here when it has to be, before anything crosses the wire. A phone
  // photograph is routinely 4–12MB and the platform refuses a request body over
  // 4.5MB *before* the route runs — so an oversized photo used to fail with no
  // message the app had written. Uploading pixels the server would only
  // downscale anyway is also the slowest possible thing to do on a phone.
  const toSend = needsClientDownscale(file.size)
    ? await shrinkForUpload(file, CLIENT_MAX_EDGE[target.uploadKind])
    : file

  const body = new FormData()
  body.set('kind', target.uploadKind)
  if (target.projectId) body.set('projectId', target.projectId)
  if (target.unitId) body.set('unitId', target.unitId)
  body.set('file', toSend)

  let response: Response
  try {
    response = await fetch('/api/uploads/images', { method: 'POST', body })
  } catch {
    throw new Error('The upload could not reach the server. Check your connection and try again.')
  }

  const payload = (await response.json().catch(() => null)) as { url?: string; error?: string } | null
  if (!response.ok || !payload?.url) {
    // The server's own sentence wherever there is one — "that file is not a
    // PNG, JPEG or WebP image" is worth far more than "upload failed".
    if (payload?.error) throw new Error(payload.error)

    // No sentence at all means the reply did not come from the route: the
    // platform rejected the request before it ran, or something upstream
    // returned HTML. Naming the status is what makes that diagnosable instead
    // of a shrug — the previous generic message sent someone hunting through
    // an upload pipeline that had never been reached.
    if (response.status === 413) {
      throw new Error('That image is too large to send. Try a smaller one.')
    }
    throw new Error(`That upload failed (${response.status}). Try again.`)
  }
  return payload.url
}

/**
 * Re-encode an image to fit inside the request cap, in the browser.
 *
 * JPEG at a bounded long edge, quality stepped down until it fits. JPEG rather
 * than PNG because this only ever runs on files that are already too big, which
 * in practice means photographs — and a 12MB photo re-encoded as PNG would grow
 * rather than shrink. A floor plan small enough to upload as-is never reaches
 * here, so linework is not traded away to solve a problem it does not have.
 *
 * `createImageBitmap` rather than an `<img>` and a load event: it decodes off
 * the main thread and, importantly, honours EXIF orientation, so a photo taken
 * in portrait does not arrive on its side.
 */
async function shrinkForUpload(file: File, maxEdge: number): Promise<File> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    // A file the browser cannot decode is not one the server will accept
    // either, but let the server be the one to say so — its message names the
    // formats, and this path must not invent a different vocabulary.
    return file
  }

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))

  const context = canvas.getContext('2d')
  if (!context) return file
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  // Descending quality, first one that fits wins. Three steps rather than a
  // binary search: each toBlob on a 2000px canvas costs real time on a phone,
  // and the first step already fits for almost every photograph.
  for (const quality of [0.82, 0.7, 0.6]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality)
    )
    if (blob && blob.size <= MAX_REQUEST_BYTES) {
      return new File([blob], replaceExtension(file.name), { type: 'image/jpeg' })
    }
  }

  // Still too big at the lowest quality — send the smallest attempt and let the
  // server answer. Refusing here would be this code deciding something the
  // server is better placed to decide.
  const last = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.6)
  )
  return last ? new File([last], replaceExtension(file.name), { type: 'image/jpeg' }) : file
}

/** The name is thrown away server-side anyway; this only keeps it honest. */
function replaceExtension(name: string): string {
  return `${name.replace(/\.[^./\\]+$/, '')}.jpg`
}
