import { del, put } from '@vercel/blob'
import { ownedBlobPathname } from '@/domain/uploads'
import { ServiceError } from '@/server/services/errors'

/**
 * The only place this app talks to Vercel Blob.
 *
 * Blob writes are the one new outbound dependency this feature introduces, and
 * the whole reason for a wrapper is that a dependency which can be down must not
 * be able to produce an unhandled 500 in a Server Action. Everything here either
 * succeeds or throws a `ServiceError` the calling action already knows how to
 * turn into a sentence under the form.
 *
 * The put/delete asymmetry is deliberate and is the interesting part:
 *
 *   - a **write** that fails is a failure the admin must see, because there is
 *     no image and pretending otherwise would store a URL to nothing;
 *   - a **delete** that fails is not. The new image is already saved and the
 *     column already points at it; all that is left is an orphaned blob costing
 *     a fraction of a cent. Failing the admin's save over that would undo a
 *     successful edit for a housekeeping error, so a failed delete is logged and
 *     swallowed.
 */

/** Where the token comes from. Absent locally means "uploads are not configured". */
function requireToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token) {
    throw new ServiceError(
      'File uploads are not configured on this server. Paste an image link instead.',
      'UNAVAILABLE'
    )
  }
  return token
}

export interface PutImageInput {
  /** Derived by `blobPathFor` — never anything an uploader supplied. */
  pathname: string
  bytes: Buffer
  contentType: 'image/jpeg' | 'image/png'
}

/**
 * Stores one processed image and returns its public URL.
 *
 * `addRandomSuffix: true` even though the pathname already carries a random
 * token: the two guard different things. The token makes two *different*
 * uploads to the same slot distinct; the random suffix means that even an exact
 * pathname collision — a retry, a double-tap, a token repeated by a broken
 * random source — cannot overwrite a blob some other row's URL still points at.
 * Storage is cheap; a floor plan silently replaced by a different unit's is not.
 *
 * `cacheControlMaxAge` is a year, which is safe precisely because the URL is
 * unique per upload: replacing an image mints a new URL, so nothing ever needs
 * to be invalidated. This is what makes a buyer's second visit cost no bytes.
 */
export async function putImageBlob(input: PutImageInput): Promise<string> {
  const token = requireToken()

  try {
    const result = await put(input.pathname, input.bytes, {
      access: 'public',
      addRandomSuffix: true,
      contentType: input.contentType,
      cacheControlMaxAge: 60 * 60 * 24 * 365,
      token
    })
    return result.url
  } catch (error) {
    // The reason is logged, not shown: it can carry a store id or a token
    // fragment, and none of it helps the admin looking at the form.
    console.error('[uploads] blob write failed', error)
    throw new ServiceError(
      'The image store did not accept that upload. Try again in a moment.',
      'UNAVAILABLE'
    )
  }
}

/**
 * Deletes a stored image *if it is ours* — and does nothing at all otherwise.
 *
 * "Ours" is `ownedBlobPathname`: a Vercel Blob URL whose path begins
 * `org/{orgId}/`. Both halves matter. A pasted external URL
 * (`https://partner.example/tower.jpg`) belongs to someone else and this must
 * never issue a delete against it — that is the rule the whole pasted-URL path
 * turns on. And a Blob URL under *another tenant's* prefix is equally not ours:
 * an admin could otherwise paste a rival org's blob URL into their own logo
 * field, save, replace it, and have us delete it for them.
 *
 * Returns whether a delete was actually attempted, so callers can log honestly.
 * Never throws — see the note at the top of this file.
 */
export async function deleteOwnedBlob(
  url: string | null | undefined,
  orgId: string
): Promise<boolean> {
  const pathname = ownedBlobPathname(url, orgId)
  if (!pathname) return false

  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token) return false

  try {
    // `del` takes the full URL as happily as the pathname, and the URL is what
    // we hold; passing it avoids re-deriving a key the store would have to
    // resolve back anyway.
    await del(url as string, { token })
    return true
  } catch (error) {
    console.warn(`[uploads] could not delete replaced blob ${pathname}`, error)
    return false
  }
}

/**
 * The sweep run after an image field is saved: everything that *was* stored and
 * is no longer, deleted if it was ours.
 *
 * Comparing sets rather than pairs is what makes the renders list work — an
 * admin who removes the second of three renders leaves two URLs that must
 * survive, and a positional comparison would delete the wrong one. It also makes
 * the no-op case free: saving a form without touching the image deletes nothing,
 * because the old URL is still in the new list.
 */
export async function deleteReplacedBlobs(
  previous: Array<string | null | undefined>,
  next: Array<string | null | undefined>,
  orgId: string
): Promise<void> {
  const kept = new Set(next.filter((url): url is string => Boolean(url)))
  const dropped = previous.filter((url): url is string => Boolean(url) && !kept.has(url as string))

  // Sequential rather than concurrent: this runs after the user's save has
  // already succeeded, there are at most nine of them, and hammering the store
  // with a burst to clean up is not worth the millisecond.
  for (const url of dropped) {
    await deleteOwnedBlob(url, orgId)
  }
}
