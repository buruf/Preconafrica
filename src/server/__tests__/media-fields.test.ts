import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageUrlField, RenderUrlsField, imageFieldFrom } from '@/server/services/media'
import { UpdateUnitSchema } from '@/server/services/units'
import { UpdateProjectImagerySchema } from '@/server/services/projects'
import { UpdateOrganizationSchema } from '@/server/services/team'
import { fetchGuardedImage, toPdfImage } from '@/server/media/images'

/**
 * The form-facing half of the imagery work: what an admin's keystrokes become
 * before they reach a column, and what the fetch wrapper does with a URL the
 * guard refuses.
 */

describe('ImageUrlField', () => {
  it('normalises a good URL', () => {
    expect(ImageUrlField.parse('  https://cdn.example.com/a.png  ')).toBe(
      'https://cdn.example.com/a.png'
    )
  })

  it('parses an empty field to null, so an emptied box clears the column', () => {
    // The bug this pins: storing '' leaves a falsy string in a nullable column
    // that every display site has to remember to treat as unset — and one of
    // them forgets, and renders a broken image instead of the placeholder.
    expect(ImageUrlField.parse('')).toBeNull()
    expect(ImageUrlField.parse('   ')).toBeNull()
  })

  it('surfaces the reason the guard gave, not a generic "invalid"', () => {
    const result = ImageUrlField.safeParse('http://169.254.169.254/latest/meta-data/')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].message).toMatch(/https/)
  })
})

describe('RenderUrlsField', () => {
  it('splits lines and drops the blanks', () => {
    expect(RenderUrlsField.parse('https://cdn.example.com/a.png\n\nhttps://cdn.example.com/b.png')).toEqual([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png'
    ])
  })

  it('parses an empty textarea to an empty array, which clears the list', () => {
    expect(RenderUrlsField.parse('')).toEqual([])
  })

  it('refuses a bad line', () => {
    expect(RenderUrlsField.safeParse('https://cdn.example.com/a.png\nfile:///etc/passwd').success).toBe(
      false
    )
  })
})

describe('UpdateUnitSchema', () => {
  it('leaves an absent image field alone and clears a present-but-empty one', () => {
    // The whole point of `imageFieldFrom`: undefined means "the form did not
    // carry this", '' means "the admin emptied it". updateUnit branches on
    // `!== undefined`, so collapsing the two would make clearing impossible.
    const untouched = UpdateUnitSchema.parse({ name: '3B' })
    expect(untouched.layoutImageUrl).toBeUndefined()
    expect(untouched.renderImageUrls).toBeUndefined()

    const cleared = UpdateUnitSchema.parse({ layoutImageUrl: '', renderImageUrls: '' })
    expect(cleared.layoutImageUrl).toBeNull()
    expect(cleared.renderImageUrls).toEqual([])
  })

  it('carries valid imagery through', () => {
    const parsed = UpdateUnitSchema.parse({
      layoutImageUrl: 'https://cdn.example.com/plan.png',
      renderImageUrls: 'https://cdn.example.com/1.jpg\nhttps://cdn.example.com/2.jpg'
    })
    expect(parsed.layoutImageUrl).toBe('https://cdn.example.com/plan.png')
    expect(parsed.renderImageUrls).toHaveLength(2)
  })

  it('refuses a loopback layout URL at the form, not at render time', () => {
    expect(UpdateUnitSchema.safeParse({ layoutImageUrl: 'https://127.0.0.1/x.png' }).success).toBe(
      false
    )
  })
})

describe('imageFieldFrom', () => {
  it('distinguishes a missing field from an empty one', () => {
    const form = new FormData()
    form.set('layoutImageUrl', '')
    expect(imageFieldFrom(form, 'layoutImageUrl')).toBe('')
    expect(imageFieldFrom(form, 'renderImageUrls')).toBeUndefined()
  })
})

describe('the project and organisation schemas share the one field', () => {
  it('clears both to null on an empty submission', () => {
    expect(UpdateProjectImagerySchema.parse({ heroImageUrl: '' }).heroImageUrl).toBeNull()
    expect(UpdateOrganizationSchema.parse({ logoUrl: '' }).logoUrl).toBeNull()
  })

  it('refuses the metadata endpoint through either of them', () => {
    const hostile = 'http://169.254.169.254/latest/meta-data/'
    expect(UpdateProjectImagerySchema.safeParse({ heroImageUrl: hostile }).success).toBe(false)
    expect(UpdateOrganizationSchema.safeParse({ logoUrl: hostile }).success).toBe(false)
  })
})

describe('fetchGuardedImage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('refuses the hostile set without issuing a request at all', async () => {
    // The assertion that matters is the second one: these are refused by the
    // pure guard, so nothing reaches the network. A regression that let one
    // through would show up here as a `fetch` call, not merely as a non-null
    // return.
    const spy = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:5432',
      'https://127.0.0.1/x.png',
      'https://10.0.0.5/logo.png',
      'file:///etc/passwd',
      'data:image/png;base64,iVBORw0KGgo=',
      'https://db.internal/logo.png'
    ]) {
      await expect(fetchGuardedImage(url)).resolves.toBeNull()
    }

    expect(spy).not.toHaveBeenCalled()
  })

  it('returns null for a blank or absent URL without complaining', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(fetchGuardedImage(null)).resolves.toBeNull()
    await expect(fetchGuardedImage(undefined)).resolves.toBeNull()
    await expect(fetchGuardedImage('  ')).resolves.toBeNull()

    // "No logo set" is the ordinary state of an organisation, not a fault.
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('toPdfImage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('maps the two formats a PDF can carry and refuses the rest', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bytes = Buffer.from([1, 2, 3])

    expect(toPdfImage({ bytes, contentType: 'image/png' })).toEqual({ data: bytes, format: 'png' })
    expect(toPdfImage({ bytes, contentType: 'image/jpeg' })).toEqual({ data: bytes, format: 'jpg' })
    // WebP and friends are fetchable but not embeddable — placeholder, not crash.
    expect(toPdfImage({ bytes, contentType: 'image/webp' })).toBeNull()
    expect(toPdfImage(null)).toBeNull()
  })

  it('drops an image too heavy for a buyer on mobile data', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const huge = { bytes: Buffer.alloc(400 * 1024), contentType: 'image/png' }
    expect(toPdfImage(huge)).toBeNull()
  })
})
