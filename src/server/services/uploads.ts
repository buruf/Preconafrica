import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { BlobPathError, MAX_UPLOAD_BYTES, blobPathFor, checkUpload } from '@/domain/uploads'
import { downscaleImage } from '@/server/media/downscale'
import { putImageBlob } from '@/server/media/blob'

/**
 * One image, from a file picker to a URL in a column.
 *
 * The whole pipeline in one place, in the order the checks have to happen:
 *
 *   1. **ADMIN.** Imagery is org administration — the logo heads every invoice
 *      and the hero is the first thing a buyer sees — so it sits at the same
 *      level as adding an agent, not at the level of selling a unit.
 *   2. **The bytes are an image** (`checkUpload`): magic bytes, not the declared
 *      MIME type and not the extension. A browser will attach
 *      `Content-Type: image/png` to whatever a `.png` file is renamed from, and
 *      an `accept="image/*"` attribute on a file input is a hint to the file
 *      dialog, not a constraint anyone has to honour.
 *   3. **The slot exists and belongs to this org.** A project or unit id from
 *      another tenant must not appear in a path, and must not be usable to
 *      probe what exists — so a foreign id gets the same NOT_FOUND a made-up
 *      one does.
 *   4. **Downscale and re-encode**, so what is stored is what a buyer can load.
 *   5. **Store under a derived path** and hand back the URL.
 *
 * What comes back is a plain `https` URL string, which is exactly what the
 * columns already hold and exactly what `MediaImage`, `fetchGuardedImage` and
 * every PDF already know how to consume. That is the point of the whole design:
 * uploads change where the URL comes from and nothing about what it is.
 */

export const UploadScopeSchema = z
  .object({
    kind: z.enum(['building', 'layout', 'render', 'logo']),
    // Ids as they arrive from the form. Presence is checked per-kind below;
    // shape is checked by the path builder, which refuses anything that is not
    // a plain id segment.
    projectId: z.string().trim().max(64).optional(),
    unitId: z.string().trim().max(64).optional()
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'logo' && !value.projectId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Missing project for this upload.' })
    }
    if ((value.kind === 'layout' || value.kind === 'render') && !value.unitId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Missing unit for this upload.' })
    }
  })

export type UploadScope = z.infer<typeof UploadScopeSchema>

export interface UploadedImage {
  url: string
  /** Both sizes, so the action can log what the downscale actually bought. */
  originalBytes: number
  storedBytes: number
  width: number
  height: number
}

/**
 * Confirms the slot exists inside the actor's organisation.
 *
 * Not decoration: `blobPathFor` writes these ids into a public path, and a
 * unit id is also the only thing linking a stored render to the row that will
 * reference it. Scoped by `actor.orgId` in the query itself — never a read
 * followed by a comparison — so there is no window in which a foreign id is
 * accepted.
 */
async function assertScopeBelongsToOrg(actor: SessionActor, scope: UploadScope): Promise<void> {
  if (scope.kind === 'logo') return

  if (scope.unitId) {
    const unit = await prisma.unit.findFirst({
      where: { id: scope.unitId, projectId: scope.projectId, project: { orgId: actor.orgId } },
      select: { id: true }
    })
    if (!unit) throw new ServiceError('Unit not found', 'NOT_FOUND')
    return
  }

  const project = await prisma.project.findFirst({
    where: { id: scope.projectId, orgId: actor.orgId },
    select: { id: true }
  })
  if (!project) throw new ServiceError('Project not found', 'NOT_FOUND')
}

export async function uploadImage(
  actor: SessionActor,
  scope: UploadScope,
  bytes: Buffer
): Promise<UploadedImage> {
  assertRole(actor, ['ADMIN'])

  const verdict = checkUpload(bytes)
  if (!verdict.ok) throw new ServiceError(verdict.reason, 'VALIDATION')

  await assertScopeBelongsToOrg(actor, scope)

  const encoded = await downscaleImage(bytes, scope.kind)

  let pathname: string
  try {
    pathname = blobPathFor({
      orgId: actor.orgId,
      kind: scope.kind,
      projectId: scope.projectId,
      unitId: scope.unitId,
      // Sixteen hex characters from the CSPRNG. The uploader's filename is not
      // in here and never will be: it is attacker-controlled text that would
      // land in a public URL, and deriving the name from the slot costs nothing.
      token: randomBytes(8).toString('hex'),
      extension: encoded.extension
    })
  } catch (error) {
    if (error instanceof BlobPathError) {
      // Only reachable if an id in our own database stops looking like an id.
      console.error('[uploads] refused to build a blob path', error)
      throw new ServiceError('Could not store that image.', 'VALIDATION')
    }
    throw error
  }

  const url = await putImageBlob({
    pathname,
    bytes: encoded.bytes,
    contentType: encoded.contentType
  })

  console.info(
    `[uploads] ${scope.kind}: ${encoded.originalBytes} -> ${encoded.bytes.byteLength} bytes ` +
      `(${encoded.width}x${encoded.height}, ${encoded.contentType}) at ${pathname}`
  )

  return {
    url,
    originalBytes: encoded.originalBytes,
    storedBytes: encoded.bytes.byteLength,
    width: encoded.width,
    height: encoded.height
  }
}

export { MAX_UPLOAD_BYTES }
