import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageUrlField, RenderUrlsField, imageFieldFrom } from '@/server/services/media'
import { UpdateUnitSchema } from '@/server/services/units'
import { UpdateProjectImagerySchema } from '@/server/services/projects'
import { UpdateOrganizationSchema } from '@/server/services/team'
import { MAX_IMAGE_BYTES, fetchGuardedImage, fetchPdfImage, toPdfImage } from '@/server/media/images'

/** A real PNG signature — the sniff reads the bytes, so fixtures must be honest. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
/** SOI + the APP0 marker that follows it in any JFIF file. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
/** What a CDN behind a misconfigured origin actually serves as `image/png`. */
const HTML_ERROR_PAGE = Buffer.from('<!doctype html><title>502 Bad Gateway</title>', 'latin1')
/** A PNG whose signature was cut short — one byte in, and no longer a PNG. */
const TRUNCATED_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])

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

/**
 * The wrapper's *own* rules — the ones that only apply once a response exists,
 * which the refusal test above can say nothing about because nothing reaches the
 * network there. These are the four most likely to be broken by a future edit,
 * so each gets a response built to trip exactly one of them.
 *
 * NETWORK DEPENDENCY, deliberate and explicit: `fetchGuardedImage` resolves the
 * hostname through `node:dns` *before* it calls `fetch`, and stubbing `fetch`
 * does not stub the resolver. So these use `example.com`, which must genuinely
 * resolve to a public address for the test to reach the stub at all. On an
 * offline or DNS-less CI box these fail at 'host does not resolve' — which is
 * the same `null`, so the assertions still pass, but a reader chasing a related
 * failure should know the resolution is real and the fetch is not.
 */
describe("fetchGuardedImage's response rules", () => {
  const URL_UNDER_TEST = 'https://example.com/logo.png'

  afterEach(() => vi.unstubAllGlobals())

  /** Stubs fetch to answer once with `response`, and reports whether it ran. */
  function answerWith(response: Response) {
    const fetchStub = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetchStub)
    return fetchStub
  }

  function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      }
    })
  }

  it('refuses a redirect outright rather than following it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Following would mean re-running the whole guard per hop; the cost of
    // refusing is that an admin pastes the final URL. The hop here points at the
    // metadata endpoint, which is what following would end up requesting.
    const fetchStub = answerWith(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
    )

    await expect(fetchGuardedImage(URL_UNDER_TEST)).resolves.toBeNull()
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.join(' ')).toMatch(/redirected \(302\)/)
    warn.mockRestore()
  })

  it('refuses an HTML page, whatever it is served under', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    answerWith(
      new Response(HTML_ERROR_PAGE, { status: 200, headers: { 'content-type': 'text/html' } })
    )

    await expect(fetchGuardedImage(URL_UNDER_TEST)).resolves.toBeNull()
  })

  it('refuses SVG, which is a document format and not a bitmap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // It can carry script and external references, and nothing here decodes it.
    answerWith(
      new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' }
      })
    )

    await expect(fetchGuardedImage(URL_UNDER_TEST)).resolves.toBeNull()
    expect(warn.mock.calls.join(' ')).toMatch(/SVG/)
    warn.mockRestore()
  })

  it('stops an oversize body mid-stream when no Content-Length was declared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The point of the missing header: a host that declares nothing cannot be
    // caught by the fast-path check, so the *streaming* cap is the only thing
    // between this and 6MB in memory. A `Response` built from a stream carries
    // no content-length, which is exactly the shape being tested.
    const megabyte = new Uint8Array(1024 * 1024)
    megabyte.set(PNG) // plausible enough to have got past the header checks
    const chunks = Array.from({ length: 6 }, () => megabyte)
    answerWith(
      new Response(streamOf(chunks), { status: 200, headers: { 'content-type': 'image/png' } })
    )

    await expect(fetchGuardedImage(URL_UNDER_TEST)).resolves.toBeNull()
    expect(warn.mock.calls.join(' ')).toMatch(
      new RegExp(`body exceeded the ${MAX_IMAGE_BYTES}-byte cap`)
    )
    warn.mockRestore()
  })

  it('refuses a 200 that carries no bytes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A stream that opens and closes, rather than a null body: this is the
    // `total === 0` branch, which is the one an empty file on a CDN produces.
    answerWith(new Response(streamOf([]), { status: 200, headers: { 'content-type': 'image/png' } }))

    await expect(fetchGuardedImage(URL_UNDER_TEST)).resolves.toBeNull()
    expect(warn.mock.calls.join(' ')).toMatch(/zero-length body/)
    warn.mockRestore()
  })

  it('calls an abort during the body read a timeout, not a transfer failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The slowloris shape: headers arrive promptly, so the timeout fires at the
    // *body* stage — a different catch block from the one around `fetch`, and
    // the one that used to report 'transfer failed'. An admin reading that went
    // looking for a broken CDN when the answer was "your host is too slow".
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError'
    })
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG)
        controller.error(timeout)
      }
    })
    answerWith(new Response(stalling, { status: 200, headers: { 'content-type': 'image/png' } }))

    await expect(fetchGuardedImage(URL_UNDER_TEST)).resolves.toBeNull()
    const logged = warn.mock.calls.join(' ')
    expect(logged).toMatch(/timed out/)
    expect(logged).not.toMatch(/transfer failed/)
    warn.mockRestore()
  })

  it('still says transfer failed for a body that breaks for any other reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A connection reset mid-body is not a timeout, and must not be relabelled
    // as one — the point of the change is that the two are distinguishable.
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(Object.assign(new Error('socket hang up'), { name: 'Error' }))
      }
    })
    answerWith(new Response(broken, { status: 200, headers: { 'content-type': 'image/png' } }))

    await expect(fetchGuardedImage(URL_UNDER_TEST)).resolves.toBeNull()
    expect(warn.mock.calls.join(' ')).toMatch(/transfer failed/)
    warn.mockRestore()
  })

  it('fetches a genuine PNG through every rule, so the refusals mean something', async () => {
    // The control. Without it, every assertion above is satisfied by a wrapper
    // that returns null unconditionally.
    answerWith(new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }))

    const fetched = await fetchGuardedImage(URL_UNDER_TEST)
    expect(fetched?.contentType).toBe('image/png')
    expect(fetched?.bytes.equals(PNG)).toBe(true)
  })

  it('yields no PDF image when a declared image/png is not PNG bytes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The end-to-end version of the sniff: the wrapper accepts it (the header
    // said image/png and the body is non-empty and under the cap), and the
    // format resolution is what refuses it — so the masthead prints initials
    // rather than the empty box a mis-decoded buffer would have drawn.
    answerWith(
      new Response(HTML_ERROR_PAGE, { status: 200, headers: { 'content-type': 'image/png' } })
    )

    await expect(fetchPdfImage(URL_UNDER_TEST)).resolves.toBeNull()
    expect(warn.mock.calls.join(' ')).toMatch(/neither PNG nor JPEG/)
    warn.mockRestore()
  })
})

describe('toPdfImage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads the format out of the bytes, not out of the Content-Type', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(toPdfImage({ bytes: PNG, contentType: 'image/png' })).toEqual({
      data: PNG,
      format: 'png'
    })
    expect(toPdfImage({ bytes: JPEG, contentType: 'image/jpeg' })).toEqual({
      data: JPEG,
      format: 'jpg'
    })
    expect(toPdfImage(null)).toBeNull()
  })

  it('embeds a genuine JPEG a host mislabelled as image/png', () => {
    // The other half of preferring bytes over headers: a wrong header must not
    // cost a correct image. Declared png, is jpeg, embeds as jpg.
    expect(toPdfImage({ bytes: JPEG, contentType: 'image/png' })).toEqual({
      data: JPEG,
      format: 'jpg'
    })
  })

  it('refuses bytes that are not PNG or JPEG whatever the header claims', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The failure this pins: a CDN serving an HTML error page or a truncated
    // file as image/png. @react-pdf hands the buffer to the decoder the format
    // names, and a decoder given the wrong bytes draws an *empty box* — so
    // trusting the header defeated the initials placeholder in exactly the case
    // the placeholder exists for.
    expect(toPdfImage({ bytes: HTML_ERROR_PAGE, contentType: 'image/png' })).toBeNull()
    expect(toPdfImage({ bytes: TRUNCATED_PNG, contentType: 'image/png' })).toBeNull()
    // WebP and friends are fetchable but not embeddable — placeholder, not crash.
    expect(toPdfImage({ bytes: WEBP, contentType: 'image/webp' })).toBeNull()
    // And a buffer too short to hold either signature must not read off the end.
    expect(toPdfImage({ bytes: Buffer.from([0xff, 0xd8]), contentType: 'image/jpeg' })).toBeNull()
    expect(toPdfImage({ bytes: Buffer.alloc(0), contentType: 'image/png' })).toBeNull()
  })

  it('drops an image too heavy for a buyer on mobile data', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Genuinely PNG-signed, so the size cap is what refuses it rather than the
    // format sniff — the two rules have to be testable apart.
    const huge = { bytes: Buffer.concat([PNG, Buffer.alloc(400 * 1024)]), contentType: 'image/png' }
    expect(toPdfImage(huge)).toBeNull()
  })
})
