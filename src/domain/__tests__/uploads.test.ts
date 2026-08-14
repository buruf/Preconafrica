import { describe, expect, it } from 'vitest'
import {
  BLOB_HOST_SUFFIX,
  BlobPathError,
  MAX_UPLOAD_BYTES,
  blobPathFor,
  checkUpload,
  isManagedBlobUrl,
  isOwnedBlobUrl,
  ownedBlobPathname,
  sniffImageFormat
} from '@/domain/uploads'

/**
 * The three decisions the upload path turns on, all of them pure:
 *
 *   - are these bytes an image, judged by what they contain rather than by what
 *     the browser or the filename claimed;
 *   - where does a stored image live, and can anything a user supplied get into
 *     that path;
 *   - and — the one with teeth — when an image is replaced, is the old one ours
 *     to delete.
 */

/* --------------------------------------------------------------- fixtures */

const pad = (head: number[], length = 64) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, length - head.length))])

const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const WEBP = pad([
  // R     I     F     F   <----- size ----->   W     E     B     P
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
])

/** What actually turns up when someone renames an error page to `photo.png`. */
const HTML = Buffer.from(
  '<!doctype html><html><head><title>Not an image</title></head><body>hi</body></html>',
  'latin1'
)
/** SVG is a document format that can carry script; nothing here decodes it. */
const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
  'latin1'
)
const EMPTY = Buffer.alloc(0)
const OVERSIZE = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES)])

/* ------------------------------------------------------------------ sniff */

describe('sniffImageFormat', () => {
  it('recognises the three formats a browser will upload', () => {
    expect(sniffImageFormat(PNG)).toBe('png')
    expect(sniffImageFormat(JPEG)).toBe('jpeg')
    expect(sniffImageFormat(WEBP)).toBe('webp')
  })

  it('is not fooled by a rename: HTML with a .png name is not a PNG', () => {
    expect(sniffImageFormat(HTML)).toBeNull()
  })

  it('refuses SVG, which is a document rather than a bitmap', () => {
    expect(sniffImageFormat(SVG)).toBeNull()
  })

  it('refuses a truncated signature', () => {
    // One byte short of PNG's eight — no longer a PNG, and a decoder handed it
    // would produce an empty box rather than an error.
    expect(sniffImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]))).toBeNull()
  })

  it('refuses a RIFF container that is not WebP', () => {
    // A .wav is RIFF too. The fourcc at offset 8 is what distinguishes them.
    const wav = pad([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
    expect(sniffImageFormat(wav)).toBeNull()
  })

  it('refuses an empty buffer', () => {
    expect(sniffImageFormat(EMPTY)).toBeNull()
  })
})

describe('checkUpload', () => {
  it('accepts a PNG, a JPEG and a WebP', () => {
    expect(checkUpload(PNG)).toEqual({ ok: true, format: 'png' })
    expect(checkUpload(JPEG)).toEqual({ ok: true, format: 'jpeg' })
    expect(checkUpload(WEBP)).toEqual({ ok: true, format: 'webp' })
  })

  it('rejects HTML renamed .png, and says so in words an admin can act on', () => {
    const verdict = checkUpload(HTML)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).toMatch(/not a PNG, JPEG or WebP/i)
  })

  it('rejects an SVG', () => {
    expect(checkUpload(SVG).ok).toBe(false)
  })

  it('rejects an empty file as empty, not as "not an image"', () => {
    const verdict = checkUpload(EMPTY)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).toMatch(/empty/i)
  })

  it('rejects an oversize buffer by size, before it looks inside', () => {
    // Genuinely a PNG — so if this passed the size check it would be accepted,
    // which is exactly what must not happen.
    expect(sniffImageFormat(OVERSIZE)).toBe('png')
    const verdict = checkUpload(OVERSIZE)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).toMatch(/under 10MB/i)
  })
})

/* ------------------------------------------------------------ path builder */

describe('blobPathFor', () => {
  const org = 'org_sunrise'
  const project = 'prj_alpha'
  const unit = 'unt_3b'
  const token = 'a1b2c3d4e5f60718'

  it('puts the tenant first, in a stable shape, for every kind', () => {
    expect(blobPathFor({ orgId: org, kind: 'logo', token, extension: 'png' })).toBe(
      'org/org_sunrise/logo-a1b2c3d4e5f60718.png'
    )
    expect(
      blobPathFor({ orgId: org, kind: 'building', projectId: project, token, extension: 'jpg' })
    ).toBe('org/org_sunrise/project/prj_alpha/hero-a1b2c3d4e5f60718.jpg')
    expect(
      blobPathFor({
        orgId: org,
        kind: 'layout',
        projectId: project,
        unitId: unit,
        token,
        extension: 'png'
      })
    ).toBe('org/org_sunrise/project/prj_alpha/unit/unt_3b/layout-a1b2c3d4e5f60718.png')
    expect(
      blobPathFor({
        orgId: org,
        kind: 'render',
        projectId: project,
        unitId: unit,
        token,
        extension: 'jpg'
      })
    ).toBe('org/org_sunrise/project/prj_alpha/unit/unt_3b/render-a1b2c3d4e5f60718.jpg')
  })

  it('encodes the orgId as the first path segment, which is what ownership rests on', () => {
    const path = blobPathFor({ orgId: org, kind: 'logo', token, extension: 'png' })
    expect(path.startsWith(`org/${org}/`)).toBe(true)
  })

  it('takes no filename at all — there is no parameter one could arrive through', () => {
    // The signature is the guarantee: `BlobPathInput` has orgId, kind, the two
    // ids, a token and an extension. A name the uploader chose is not among
    // them, so it cannot reach a public URL by any route, deliberate or
    // accidental. What a caller *can* pass is asserted below.
    const path = blobPathFor({
      orgId: org,
      kind: 'building',
      projectId: project,
      token,
      extension: 'jpg'
    })
    expect(path).not.toMatch(/[^A-Za-z0-9/_.-]/)
  })

  it('refuses an id that is not a plain id segment rather than sanitising it', () => {
    // Traversal, a slash, whitespace, and something far too long. Each stops the
    // build: quietly stripping characters would produce a path nobody intended
    // and, in the traversal case, one under a different tenant's prefix.
    expect(() =>
      blobPathFor({ orgId: '../other-org', kind: 'logo', token, extension: 'png' })
    ).toThrow(BlobPathError)
    expect(() =>
      blobPathFor({ orgId: org, kind: 'building', projectId: 'a/b', token, extension: 'jpg' })
    ).toThrow(BlobPathError)
    expect(() =>
      blobPathFor({ orgId: org, kind: 'logo', token: 'has space', extension: 'png' })
    ).toThrow(BlobPathError)
    expect(() =>
      blobPathFor({ orgId: 'x'.repeat(65), kind: 'logo', token, extension: 'png' })
    ).toThrow(BlobPathError)
  })

  it('refuses to build a path for a slot whose ids are missing', () => {
    expect(() => blobPathFor({ orgId: org, kind: 'building', token, extension: 'jpg' })).toThrow(
      BlobPathError
    )
    expect(() =>
      blobPathFor({ orgId: org, kind: 'render', projectId: project, token, extension: 'jpg' })
    ).toThrow(BlobPathError)
  })
})

/* -------------------------------------------------------- ours, or theirs */

describe('isManagedBlobUrl', () => {
  it('recognises a Vercel Blob URL', () => {
    expect(isManagedBlobUrl(`https://abc123${BLOB_HOST_SUFFIX}/org/o1/logo-x.png`)).toBe(true)
  })

  it('does not recognise an arbitrary external URL', () => {
    expect(isManagedBlobUrl('https://cdn.example.com/tower.jpg')).toBe(false)
    expect(isManagedBlobUrl('https://images.unsplash.com/photo-1.jpg')).toBe(false)
  })

  it('is not fooled by the suffix appearing somewhere other than the host', () => {
    expect(isManagedBlobUrl(`https://evil.example.com/?x=${BLOB_HOST_SUFFIX}`)).toBe(false)
    expect(isManagedBlobUrl(`https://evil.example.com${BLOB_HOST_SUFFIX}.attacker.test/a.png`)).toBe(
      false
    )
  })

  it('requires https, and survives junk', () => {
    expect(isManagedBlobUrl(`http://abc123${BLOB_HOST_SUFFIX}/a.png`)).toBe(false)
    expect(isManagedBlobUrl('not a url')).toBe(false)
    expect(isManagedBlobUrl(null)).toBe(false)
    expect(isManagedBlobUrl('')).toBe(false)
  })
})

describe('isOwnedBlobUrl', () => {
  const ours = `https://store1${BLOB_HOST_SUFFIX}/org/org_sunrise/project/p1/hero-abc.jpg`

  it('says yes to this org’s own blob', () => {
    expect(isOwnedBlobUrl(ours, 'org_sunrise')).toBe(true)
    expect(ownedBlobPathname(ours, 'org_sunrise')).toBe('org/org_sunrise/project/p1/hero-abc.jpg')
  })

  it('says no to a URL somebody pasted — it is not ours to delete', () => {
    // The whole reason the predicate exists. An admin who pasted a partner
    // developer's photo and later uploads a real one must not have us issue a
    // delete against an asset that is not ours.
    const pasted = 'https://cdn.partner.example/towers/sunrise-hero.jpg'
    expect(isOwnedBlobUrl(pasted, 'org_sunrise')).toBe(false)
    expect(ownedBlobPathname(pasted, 'org_sunrise')).toBeNull()
  })

  it('says no to another tenant’s blob, even though it is in a blob store', () => {
    // Paste a rival org's blob URL into your own logo field, save, replace it —
    // and without this half of the check we would delete their image for them.
    expect(isOwnedBlobUrl(ours, 'org_other')).toBe(false)
    expect(ownedBlobPathname(ours, 'org_other')).toBeNull()
  })

  it('is not fooled by a tenant id that is a prefix of another', () => {
    // `org/org_sunrise2/...` must not match orgId `org_sunrise`, which is what
    // the trailing slash in the prefix is for.
    const neighbour = `https://store1${BLOB_HOST_SUFFIX}/org/org_sunrise2/logo-a.png`
    expect(isOwnedBlobUrl(neighbour, 'org_sunrise')).toBe(false)
  })

  it('says no when there is nothing to judge', () => {
    expect(isOwnedBlobUrl(null, 'org_sunrise')).toBe(false)
    expect(isOwnedBlobUrl('', 'org_sunrise')).toBe(false)
    expect(isOwnedBlobUrl(ours, '../')).toBe(false)
  })
})
