import { MAX_UPLOAD_BYTES, type UploadKind } from '@/domain/uploads'

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

  const body = new FormData()
  body.set('kind', target.uploadKind)
  if (target.projectId) body.set('projectId', target.projectId)
  if (target.unitId) body.set('unitId', target.unitId)
  body.set('file', file)

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
    throw new Error(payload?.error ?? 'That upload failed. Try again.')
  }
  return payload.url
}
