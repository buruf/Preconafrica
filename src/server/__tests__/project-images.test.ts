import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The project gallery: photographs of what the whole development shares — the
 * gym, the pool, the lobby.
 *
 * Every test here is about scope or about the caption. Scope, because these are
 * the first images that belong to a project rather than a unit and the org
 * check is the only thing standing between tenants; the caption, because it is
 * the entire reason this is a table rather than a `String[]`.
 */

const auditCalls: Array<Record<string, unknown>> = []

vi.mock('@/server/media/blob', () => ({
  deleteReplacedBlobs: vi.fn(async () => undefined)
}))

vi.mock('@/server/audit/record', () => ({
  recordAudit: vi.fn(async (_tx: unknown, _a: unknown, input: Record<string, unknown>) => {
    auditCalls.push(input)
  })
}))

type Args = { data: Record<string, unknown>; where?: Record<string, unknown> }

const imageCreate = vi.fn(async (_a: Args) => ({ id: 'img_1', caption: 'Gym' }))
const imageUpdate = vi.fn(async (_a: Args) => ({ id: 'img_1', caption: 'Rooftop pool' }))
const imageDelete = vi.fn(async (_a: Args) => ({ id: 'img_1', url: 'https://x/y.jpg' }))
const imageFindFirst = vi.fn()
const imageAggregate = vi.fn(async () => ({ _max: { position: 2 } }))
const projectFindFirst = vi.fn()

vi.mock('@/server/db', () => ({
  prisma: {
    project: { findFirst: projectFindFirst },
    projectImage: {
      create: imageCreate,
      update: imageUpdate,
      delete: imageDelete,
      findFirst: imageFindFirst,
      aggregate: imageAggregate
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ projectImage: { create: imageCreate, update: imageUpdate, delete: imageDelete } })
    )
  }
}))

const { prisma } = await import('@/server/db')
const { addProjectImage, updateProjectImageCaption, removeProjectImage } = await import(
  '@/server/services/project-images'
)

const ADMIN = { userId: 'u1', orgId: 'org_1', role: 'ADMIN', fullName: 'Adaeze' } as never
const AGENT = { userId: 'u2', orgId: 'org_1', role: 'AGENT', fullName: 'Tunde' } as never

const OURS = 'https://x.public.blob.vercel-storage.com/org/org_1/project/p1/gallery-abc.jpg'

beforeEach(() => {
  auditCalls.length = 0
  imageCreate.mockClear()
  imageUpdate.mockClear()
  imageDelete.mockClear()
  projectFindFirst.mockResolvedValue({ id: 'p1', name: 'Khaleel Heights' } as never)
  imageFindFirst.mockResolvedValue({
    id: 'img_1',
    url: OURS,
    caption: 'Gym',
    project: { id: 'p1', name: 'Khaleel Heights' }
  } as never)
  imageAggregate.mockResolvedValue({ _max: { position: 2 } } as never)
})

describe('addProjectImage', () => {
  it('stores the photo with its caption', async () => {
    await addProjectImage(ADMIN, { projectId: 'p1', url: OURS, caption: 'Gym' })
    expect(imageCreate.mock.calls[0][0].data).toMatchObject({
      projectId: 'p1',
      url: OURS,
      caption: 'Gym'
    })
  })

  it('appends to the end rather than the front', async () => {
    // Position exists so the gallery reads in the order it was built.
    await addProjectImage(ADMIN, { projectId: 'p1', url: OURS, caption: 'Pool' })
    expect(imageCreate.mock.calls[0][0].data.position).toBe(3)
  })

  it('starts at zero for the first photo', async () => {
    imageAggregate.mockResolvedValue({ _max: { position: null } } as never)
    await addProjectImage(ADMIN, { projectId: 'p1', url: OURS })
    expect(imageCreate.mock.calls[0][0].data.position).toBe(0)
  })

  it('keeps a blank caption as no caption', async () => {
    // An empty string would render as an empty label under the photo.
    await addProjectImage(ADMIN, { projectId: 'p1', url: OURS, caption: '   ' })
    expect(imageCreate.mock.calls[0][0].data.caption).toBeNull()
  })

  it('refuses an agent', async () => {
    await expect(
      addProjectImage(AGENT, { projectId: 'p1', url: OURS, caption: 'Gym' })
    ).rejects.toThrow()
    expect(imageCreate).not.toHaveBeenCalled()
  })

  it("refuses another organisation's project", async () => {
    projectFindFirst.mockResolvedValue(null as never)
    await expect(addProjectImage(ADMIN, { projectId: 'p1', url: OURS })).rejects.toThrow(
      'not found'
    )
    expect(imageCreate).not.toHaveBeenCalled()
  })

  it('refuses an image this organisation did not upload', async () => {
    await expect(
      addProjectImage(ADMIN, { projectId: 'p1', url: 'https://elsewhere.example/gym.jpg' })
    ).rejects.toThrow('not one this organisation uploaded')
    expect(imageCreate).not.toHaveBeenCalled()
  })

  it("refuses another tenant's blob", async () => {
    await expect(
      addProjectImage(ADMIN, {
        projectId: 'p1',
        url: 'https://x.public.blob.vercel-storage.com/org/org_other/project/p9/gallery-abc.jpg'
      })
    ).rejects.toThrow('not one this organisation uploaded')
    expect(imageCreate).not.toHaveBeenCalled()
  })

  it('records it', async () => {
    await addProjectImage(ADMIN, { projectId: 'p1', url: OURS, caption: 'Gym' })
    expect(auditCalls[0]).toMatchObject({
      action: 'project.image_added',
      entityType: 'Project',
      entityLabel: 'Khaleel Heights'
    })
  })
})

describe('updateProjectImageCaption', () => {
  it('renames a photo', async () => {
    await updateProjectImageCaption(ADMIN, 'img_1', 'Rooftop pool')
    expect(imageUpdate.mock.calls[0][0].data.caption).toBe('Rooftop pool')
  })

  it('clears a caption when emptied', async () => {
    await updateProjectImageCaption(ADMIN, 'img_1', '  ')
    expect(imageUpdate.mock.calls[0][0].data.caption).toBeNull()
  })

  it("refuses a photo in another organisation's project", async () => {
    // Scoped by the org on the *image's* project, so a guessed id is NOT_FOUND
    // rather than an edit of someone else's gallery.
    imageFindFirst.mockResolvedValue(null as never)
    await expect(updateProjectImageCaption(ADMIN, 'img_1', 'Gym')).rejects.toThrow('not found')
    expect(imageUpdate).not.toHaveBeenCalled()
  })

  it('refuses an agent', async () => {
    await expect(updateProjectImageCaption(AGENT, 'img_1', 'Gym')).rejects.toThrow()
    expect(imageUpdate).not.toHaveBeenCalled()
  })
})

describe('removeProjectImage', () => {
  it('deletes it', async () => {
    await removeProjectImage(ADMIN, 'img_1')
    expect(imageDelete).toHaveBeenCalledOnce()
  })

  it("refuses a photo in another organisation's project", async () => {
    imageFindFirst.mockResolvedValue(null as never)
    await expect(removeProjectImage(ADMIN, 'img_1')).rejects.toThrow('not found')
    expect(imageDelete).not.toHaveBeenCalled()
  })

  it('refuses an agent', async () => {
    await expect(removeProjectImage(AGENT, 'img_1')).rejects.toThrow()
    expect(imageDelete).not.toHaveBeenCalled()
  })

  it('records it', async () => {
    await removeProjectImage(ADMIN, 'img_1')
    expect(auditCalls[0]).toMatchObject({ action: 'project.image_removed' })
  })
})
