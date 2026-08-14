import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { sniffImageFormat } from '@/domain/uploads'
import { IMAGE_PROFILES, downscaleImage } from '@/server/media/downscale'
import { toPdfImage } from '@/server/media/images'
import { ServiceError } from '@/server/services/errors'

/**
 * What the downscaler has to be true about, exercised against real bytes
 * through real sharp rather than a mock — the whole point of this module is
 * what an encoder actually produces, and a mocked encoder tests nothing.
 */

/**
 * A photo-like image: low-resolution noise scaled up, which gives smooth
 * gradients and detail the way a photograph does. A flat fill would compress to
 * nothing and prove that a 6MB brochure export shrinks, which is not the same
 * claim.
 */
async function photoLike(width: number, height: number): Promise<Buffer> {
  const tileW = 96
  const tileH = Math.max(1, Math.round((height / width) * tileW))
  const noise = Buffer.alloc(tileW * tileH * 3)
  // Deterministic: a seeded LCG, so a flaky byte count can never be blamed on
  // the fixture.
  let seed = 20260813
  for (let i = 0; i < noise.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    noise[i] = seed % 256
  }

  return sharp(noise, { raw: { width: tileW, height: tileH, channels: 3 } })
    .resize(width, height, { kernel: 'cubic' })
    .png()
    .toBuffer()
}

/** Line art: white ground, thin black strokes and small text-sized marks. */
async function planLike(width: number, height: number): Promise<Buffer> {
  const strokes: string[] = []
  for (let i = 0; i < 40; i += 1) {
    const x = 20 + i * 45
    strokes.push(`<rect x="${x}" y="30" width="2" height="${height - 60}" fill="#000"/>`)
    strokes.push(`<rect x="30" y="${30 + i * 37}" width="${width - 60}" height="2" fill="#000"/>`)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fff"/>${strokes.join('')}</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

async function dimensions(bytes: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(bytes).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}

describe('downscaleImage', () => {
  it(
    'brings a large photo under both the pixel cap and the byte budget',
    async () => {
      const input = await photoLike(4000, 3000)
      const out = await downscaleImage(input, 'building')

      expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(
        IMAGE_PROFILES.building.maxEdge
      )
      expect(out.bytes.byteLength).toBeLessThanOrEqual(IMAGE_PROFILES.building.budgetBytes)
      // The claim the whole feature rests on: a buyer on a weak connection is
      // not made to download the original.
      expect(out.bytes.byteLength).toBeLessThan(input.byteLength)
      expect(out.originalBytes).toBe(input.byteLength)
    },
    30_000
  )

  it(
    'never upscales a small image',
    async () => {
      // Well under every profile's cap. Storing it larger than it arrived would
      // be strictly worse: bigger file, no more detail.
      const input = await photoLike(300, 200)
      for (const kind of ['building', 'render', 'layout', 'logo'] as const) {
        const out = await downscaleImage(input, kind)
        expect({ kind, width: out.width, height: out.height }).toEqual({
          kind,
          width: 300,
          height: 200
        })
      }
    },
    30_000
  )

  it(
    'keeps a floor plan at the larger cap, because linework and room labels have to stay legible',
    async () => {
      const input = await planLike(3600, 2400)
      const out = await downscaleImage(input, 'layout')

      expect(Math.max(out.width, out.height)).toBe(IMAGE_PROFILES.layout.maxEdge)
      // Strictly larger than the photo profile would have allowed — the whole
      // reason plans have their own profile.
      expect(Math.max(out.width, out.height)).toBeGreaterThan(IMAGE_PROFILES.building.maxEdge)
      expect(out.bytes.byteLength).toBeLessThanOrEqual(IMAGE_PROFILES.layout.budgetBytes)
    },
    30_000
  )

  it(
    'always emits something a PDF can embed — never WebP',
    async () => {
      // This is not stylistic. `toPdfImage` embeds PNG and JPEG and nothing
      // else, so a WebP logo would look right on /team and print as the
      // initials placeholder on every invoice, with no error anywhere.
      const input = await photoLike(1200, 900)
      for (const kind of ['building', 'render', 'layout', 'logo'] as const) {
        const out = await downscaleImage(input, kind)
        expect(sniffImageFormat(out.bytes)).not.toBe('webp')
        expect(['png', 'jpeg']).toContain(sniffImageFormat(out.bytes))
        expect(['jpg', 'png']).toContain(out.extension)
      }
    },
    30_000
  )

  it(
    'produces a hero the PDF pipeline will actually accept',
    async () => {
      // The building profile's budget *is* MAX_PDF_IMAGE_BYTES, so this is the
      // end-to-end version of that claim: what the page shows is what the
      // statement embeds.
      const input = await photoLike(4000, 3000)
      const out = await downscaleImage(input, 'building')
      const embedded = toPdfImage({ bytes: out.bytes, contentType: out.contentType })
      expect(embedded).not.toBeNull()
    },
    30_000
  )

  it(
    'accepts a WebP upload and stores it as something embeddable',
    async () => {
      const webp = await sharp(await photoLike(1600, 1200)).webp().toBuffer()
      expect(sniffImageFormat(webp)).toBe('webp')

      const out = await downscaleImage(webp, 'render')
      expect(sniffImageFormat(out.bytes)).toBe('jpeg')
    },
    30_000
  )

  it('turns an undecodable buffer into a ServiceError, not a raw throw', async () => {
    // A genuine PNG signature followed by nothing usable: past the magic-byte
    // check, and still not an image. The admin gets a sentence.
    const corrupt = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512, 0x41)
    ])
    await expect(downscaleImage(corrupt, 'building')).rejects.toBeInstanceOf(ServiceError)
  })
})
