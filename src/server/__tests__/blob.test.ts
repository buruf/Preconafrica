import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const put = vi.fn()
const del = vi.fn()
vi.mock('@vercel/blob', () => ({ put: (...args: unknown[]) => put(...args), del: (...args: unknown[]) => del(...args) }))

const { deleteOwnedBlob, deleteReplacedBlobs, putImageBlob } = await import('@/server/media/blob')
const { ServiceError } = await import('@/server/services/errors')
const { BLOB_HOST_SUFFIX } = await import('@/domain/uploads')

/**
 * The wrapper around the one new external dependency this feature adds.
 *
 * Two behaviours are worth pinning here and neither is about Vercel: that a
 * store outage reaches the admin as a sentence rather than a 500, and that a
 * delete is only ever issued against an image that is actually ours.
 */

const ORG = 'org_sunrise'
const ours = (name: string) => `https://store1${BLOB_HOST_SUFFIX}/org/${ORG}/${name}`
const theirs = 'https://cdn.partner.example/towers/hero.jpg'
const otherTenant = `https://store1${BLOB_HOST_SUFFIX}/org/org_rival/logo-a.png`

beforeEach(() => {
  put.mockReset()
  del.mockReset()
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('putImageBlob', () => {
  it('returns the public URL the store answers with', async () => {
    put.mockResolvedValue({ url: ours('project/p1/hero-abc.jpg') })

    const url = await putImageBlob({
      pathname: `org/${ORG}/project/p1/hero-abc.jpg`,
      bytes: Buffer.from([1, 2, 3]),
      contentType: 'image/jpeg'
    })

    expect(url).toBe(ours('project/p1/hero-abc.jpg'))
    // `addRandomSuffix` is not decoration: without it a repeated pathname would
    // overwrite a blob some other row's URL still points at.
    expect(put.mock.calls[0][2]).toMatchObject({ access: 'public', addRandomSuffix: true })
  })

  it('turns a store outage into a clean ServiceError, never an unhandled throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    put.mockRejectedValue(new Error('503 Service Unavailable'))

    await expect(
      putImageBlob({ pathname: `org/${ORG}/logo-a.png`, bytes: Buffer.from([1]), contentType: 'image/png' })
    ).rejects.toMatchObject({ name: 'ServiceError', code: 'UNAVAILABLE' })
  })

  it('says so plainly when uploads are not configured at all', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN

    await expect(
      putImageBlob({ pathname: `org/${ORG}/logo-a.png`, bytes: Buffer.from([1]), contentType: 'image/png' })
    ).rejects.toBeInstanceOf(ServiceError)
    expect(put).not.toHaveBeenCalled()
  })
})

describe('deleteOwnedBlob', () => {
  it('deletes this org’s own blob', async () => {
    del.mockResolvedValue(undefined)
    await expect(deleteOwnedBlob(ours('logo-a.png'), ORG)).resolves.toBe(true)
    expect(del).toHaveBeenCalledTimes(1)
  })

  it('never touches a URL somebody pasted', async () => {
    await expect(deleteOwnedBlob(theirs, ORG)).resolves.toBe(false)
    expect(del).not.toHaveBeenCalled()
  })

  it('never touches another tenant’s blob', async () => {
    await expect(deleteOwnedBlob(otherTenant, ORG)).resolves.toBe(false)
    expect(del).not.toHaveBeenCalled()
  })

  it('swallows a failed delete: the save already succeeded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    del.mockRejectedValue(new Error('gone'))
    // An orphaned blob costs a fraction of a cent. Failing the admin's edit
    // over a housekeeping error would undo work they already did.
    await expect(deleteOwnedBlob(ours('logo-a.png'), ORG)).resolves.toBe(false)
  })
})

describe('deleteReplacedBlobs', () => {
  it('deletes only what the row stopped pointing at', async () => {
    del.mockResolvedValue(undefined)
    const kept = ours('unit/u1/render-1.jpg')
    const dropped = ours('unit/u1/render-2.jpg')

    await deleteReplacedBlobs([kept, dropped], [kept], ORG)

    expect(del).toHaveBeenCalledTimes(1)
    expect(del.mock.calls[0][0]).toBe(dropped)
  })

  it('removing the middle render leaves the other two alone', async () => {
    del.mockResolvedValue(undefined)
    const [a, b, c] = [ours('r-a.jpg'), ours('r-b.jpg'), ours('r-c.jpg')]

    // The reason the comparison is by set and not by position: paired up by
    // index, [a,b,c] -> [a,c] would look like "b became c and c was removed",
    // and would delete the wrong image.
    await deleteReplacedBlobs([a, b, c], [a, c], ORG)

    expect(del).toHaveBeenCalledTimes(1)
    expect(del.mock.calls[0][0]).toBe(b)
  })

  it('deletes nothing when a form is saved without touching the image', async () => {
    const url = ours('project/p1/hero-abc.jpg')
    await deleteReplacedBlobs([url], [url], ORG)
    expect(del).not.toHaveBeenCalled()
  })

  it('leaves a replaced external URL where it is', async () => {
    await deleteReplacedBlobs([theirs], [ours('project/p1/hero-new.jpg')], ORG)
    expect(del).not.toHaveBeenCalled()
  })
})
