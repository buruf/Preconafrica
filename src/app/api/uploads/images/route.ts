import { NextResponse } from 'next/server'
import { requireUserOrNull } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { MAX_UPLOAD_BYTES } from '@/domain/uploads'
import { UploadScopeSchema, uploadImage } from '@/server/services/uploads'

export const runtime = 'nodejs'

/**
 * sharp decoding a 10MB image and re-encoding it three or four times down a
 * quality ladder is the slowest thing this app does after a PDF render. Fifteen
 * seconds is not "how long this takes" — measured, a 6MB brochure page is under
 * two — it is enough headroom for a cold start plus a slow upstream connection,
 * while still failing fast if something genuinely runs away.
 */
export const maxDuration = 15

/**
 * Where a picked file becomes a stored URL.
 *
 * **Why a route handler and not a Server Action.** Three reasons, in order of
 * weight:
 *
 *  1. Next 14 caps a Server Action's request body at 1MB by default. Raising
 *     `experimental.serverActions.bodySizeLimit` would raise it for *every*
 *     action in the app — every login, every payment, every unit edit — to
 *     accommodate one control. A route handler streams a multipart body without
 *     that ceiling and without changing anything for the rest of the app.
 *  2. The control has to upload *before* the form is submitted. A thumbnail has
 *     to appear, an individual render has to be removable without re-uploading
 *     the other two, and a rejected file has to say so next to the picker
 *     rather than after a save. That is a per-file request/response, which is a
 *     fetch with a JSON answer, not a form post that re-renders a page.
 *  3. Errors get a status code. `useFormState` carries one string for a whole
 *     form; here a 413 and a 415 are different things the control can say
 *     differently.
 *
 * **Guarding.** `requireAdmin()` cannot be used verbatim: it is built on
 * `requireUser`, which `redirect()`s to /login, and a 307 to an HTML page is not
 * a useful answer to a `fetch`. So this does what the documents route does —
 * `requireUserOrNull`, which runs the identical deactivation and
 * password-change revocation checks against the database, and then the same
 * ADMIN assertion, returning 401/403. The authorisation that actually matters
 * is inside `uploadImage`, which calls `assertRole(actor, ['ADMIN'])` itself;
 * this is the door, not the lock.
 */
export async function POST(request: Request) {
  const actor = await requireUserOrNull()
  if (!actor) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  if (actor.role !== 'ADMIN') {
    // The same deliberately vague wording every other authorisation failure
    // uses: it must not disclose which roles qualify.
    return NextResponse.json({ error: 'You do not have access to this resource.' }, { status: 403 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'That upload could not be read.' }, { status: 400 })
  }

  const scope = UploadScopeSchema.safeParse({
    kind: form.get('kind') ?? undefined,
    projectId: form.get('projectId') || undefined,
    unitId: form.get('unitId') || undefined
  })
  if (!scope.success) {
    return NextResponse.json(
      { error: scope.error.issues[0]?.message ?? 'That upload is missing something.' },
      { status: 400 }
    )
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Choose a file to upload.' }, { status: 400 })
  }

  // The declared size, refused before a single byte is buffered. `file.size` is
  // the browser's claim rather than a measurement, so it is a fast path and not
  // the check — `checkUpload` weighs the real buffer below. Both exist because
  // reading 200MB into memory to then reject it is the failure mode worth
  // avoiding.
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `Images must be under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.` },
      { status: 413 }
    )
  }

  const bytes = Buffer.from(await file.arrayBuffer())

  try {
    const result = await uploadImage(actor, scope.data, bytes)
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof ServiceError) {
      const status = { NOT_FOUND: 404, FORBIDDEN: 403, UNAVAILABLE: 503, CONFLICT: 409 }[
        error.code as 'NOT_FOUND' | 'FORBIDDEN' | 'UNAVAILABLE' | 'CONFLICT'
      ]
      return NextResponse.json({ error: error.message }, { status: status ?? 422 })
    }

    // Anything else is a genuine fault, and the admin gets a sentence rather
    // than a stack trace or a blank 500 page.
    console.error('[uploads] unexpected failure', error)
    return NextResponse.json({ error: 'Could not store that image.' }, { status: 500 })
  }
}
