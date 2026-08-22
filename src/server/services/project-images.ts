import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { ownedBlobPathname } from '@/domain/uploads'
import { recordAudit } from '@/server/audit/record'
import { deleteReplacedBlobs } from '@/server/media/blob'

/**
 * The project gallery — photographs of what the whole development shares: the
 * gym, the pool, the lobby, the landscaping.
 *
 * These are the first images in the system that belong to a *project* rather
 * than to a unit, and that is the point. `Unit.renderImageUrls` was the only
 * multi-image field before, and it is the wrong home for a gym: it is not part
 * of flat 12B, and using it would mean uploading the same photograph onto all
 * sixty-four units.
 *
 * A table rather than a `String[]` because of the caption. An array of URLs
 * cannot say which one is the pool, and a strip of unlabelled amenity shots
 * asks a buyer to guess what they are looking at.
 */

/** Long enough for "Residents' gym and 25m indoor pool", short enough to render. */
const CAPTION_MAX = 120

export const AddProjectImageSchema = z.object({
  projectId: z.string().min(1),
  url: z.string().url(),
  caption: z.string().max(CAPTION_MAX).optional()
})

export type AddProjectImageInput = z.infer<typeof AddProjectImageSchema>

/**
 * Blank is not a caption.
 *
 * `''` and `'   '` both become null, so the gallery renders a photograph with no
 * label rather than a photograph with an empty one — which is a visible gap
 * under the image that looks like a bug.
 */
function cleanCaption(caption: string | undefined): string | null {
  const trimmed = caption?.trim()
  return trimmed ? trimmed.slice(0, CAPTION_MAX) : null
}

/**
 * The image, its project, and the org check — in one query.
 *
 * Scoped through `project.orgId` rather than by reading the image and comparing
 * afterwards, so there is no window in which another tenant's image id resolves
 * to a row. A guessed id comes back NOT_FOUND, the same answer a nonexistent one
 * gets, so the response cannot be used to probe what exists.
 */
async function ownedImage(actor: SessionActor, imageId: string) {
  const image = await prisma.projectImage.findFirst({
    where: { id: imageId, project: { orgId: actor.orgId } },
    select: {
      id: true,
      url: true,
      caption: true,
      project: { select: { id: true, name: true } }
    }
  })
  if (!image) throw new ServiceError('That photo was not found.', 'NOT_FOUND')
  return image
}

/** Add a photograph to a project's gallery. */
export async function addProjectImage(
  actor: SessionActor,
  input: AddProjectImageInput
): Promise<{ id: string }> {
  assertRole(actor, ['ADMIN'])

  const parsed = AddProjectImageSchema.safeParse(input)
  if (!parsed.success) {
    throw new ServiceError(parsed.error.issues[0]?.message ?? 'Check that photo.', 'VALIDATION')
  }

  const project = await prisma.project.findFirst({
    where: { id: parsed.data.projectId, orgId: actor.orgId },
    select: { id: true, name: true }
  })
  if (!project) throw new ServiceError('Project not found', 'NOT_FOUND')

  // The same check the floor-plan assign makes: a URL that is not a blob this
  // organisation uploaded cannot be written into a column, so a crafted request
  // cannot point the gallery at a host we do not control.
  if (ownedBlobPathname(parsed.data.url, actor.orgId) === null) {
    throw new ServiceError('That image is not one this organisation uploaded.', 'VALIDATION')
  }

  // Appended, not prepended: the gallery reads in the order the admin built it.
  // `_max` rather than a count, because a count would collide after a deletion.
  const last = await prisma.projectImage.aggregate({
    where: { projectId: project.id },
    _max: { position: true }
  })
  const position = last._max.position === null ? 0 : last._max.position + 1

  const caption = cleanCaption(parsed.data.caption)

  const created = await prisma.$transaction(async (tx) => {
    const image = await tx.projectImage.create({
      data: { projectId: project.id, url: parsed.data.url, caption, position }
    })

    await recordAudit(tx, actor, {
      action: 'project.image_added',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: project.name,
      // The caption, so the log says *which* photo — a blob URL would not.
      context: { caption: caption ?? undefined }
    })

    return image
  })

  return { id: created.id }
}

/** Rename a photograph, or clear its caption. */
export async function updateProjectImageCaption(
  actor: SessionActor,
  imageId: string,
  caption: string
): Promise<void> {
  assertRole(actor, ['ADMIN'])

  const image = await ownedImage(actor, imageId)
  const next = cleanCaption(caption)

  await prisma.$transaction(async (tx) => {
    await tx.projectImage.update({ where: { id: image.id }, data: { caption: next } })

    await recordAudit(tx, actor, {
      action: 'project.image_captioned',
      entityType: 'Project',
      entityId: image.project.id,
      entityLabel: image.project.name,
      context: { caption: next ?? undefined }
    })
  })
}

/** Remove a photograph from the gallery, and the stored file with it. */
export async function removeProjectImage(actor: SessionActor, imageId: string): Promise<void> {
  assertRole(actor, ['ADMIN'])

  const image = await ownedImage(actor, imageId)

  await prisma.$transaction(async (tx) => {
    await tx.projectImage.delete({ where: { id: image.id } })

    await recordAudit(tx, actor, {
      action: 'project.image_removed',
      entityType: 'Project',
      entityId: image.project.id,
      entityLabel: image.project.name,
      context: { caption: image.caption ?? undefined }
    })
  })

  // After the row is gone, and deliberately outside the transaction: a blob
  // delete is a network call to another service, and holding a database
  // transaction open across one is how a slow third party becomes a lock.
  //
  // Safe to delete here, unlike a shared floor plan: a gallery image has
  // exactly one row pointing at it, so nothing else can still be referencing
  // the file. If the delete fails the row is still gone and the blob is
  // orphaned, which costs storage and nothing else.
  await deleteReplacedBlobs([image.url], [], actor.orgId)
}
