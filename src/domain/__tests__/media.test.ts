import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_URL_LENGTH,
  MAX_RENDER_IMAGES,
  checkImageUrl,
  isAddressLiteral,
  isBlockedAddress,
  isFetchableImageUrl,
  parseRenderUrls
} from '@/domain/media'

/**
 * This is the SSRF guard, so the interesting assertions are all refusals. The
 * failure being guarded against is concrete: the server fetches whatever URL an
 * admin pasted in order to embed it in a PDF, so `http://169.254.169.254/…`
 * would have it read its own cloud credentials and bake them into a document a
 * user then downloads.
 */

describe('checkImageUrl', () => {
  it('accepts an ordinary https image URL, normalised', () => {
    const verdict = checkImageUrl('  https://cdn.example.com/photos/tower.jpg?v=2  ')

    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    // Trimmed, and it is the normalised form that gets stored — so the same
    // image pasted with stray whitespace is the same string in the column.
    expect(verdict.url).toBe('https://cdn.example.com/photos/tower.jpg?v=2')
    expect(verdict.hostname).toBe('cdn.example.com')
    // Not an address literal, so the fetch wrapper still has to resolve it.
    expect(verdict.hostIsAddress).toBe(false)
  })

  it('rejects every scheme but https', () => {
    // http: is the one an admin reaches for on purpose; the other two are how a
    // "URL" arrives that is not a fetch at all.
    for (const url of [
      'http://cdn.example.com/a.png',
      'file:///etc/passwd',
      'data:image/png;base64,iVBORw0KGgo=',
      'ftp://cdn.example.com/a.png',
      'javascript:alert(1)'
    ]) {
      const verdict = checkImageUrl(url)
      expect(verdict.ok, `${url} must be refused`).toBe(false)
    }
  })

  it('names https in the message, so an admin knows what to paste instead', () => {
    const verdict = checkImageUrl('http://cdn.example.com/a.png')
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).toMatch(/https/)
  })

  it('rejects hosts that name this machine or a local network', () => {
    for (const url of [
      'https://localhost/a.png',
      'https://LOCALHOST/a.png',
      'https://db.internal/a.png',
      'https://printer.local/a.png',
      'https://api.localhost/a.png'
    ]) {
      expect(checkImageUrl(url).ok, `${url} must be refused`).toBe(false)
    }
  })

  it('rejects private, loopback and link-local IP literals', () => {
    for (const url of [
      'https://127.0.0.1/x.png',
      'https://127.1.2.3/x.png',
      'https://10.0.0.5/x.png',
      'https://172.16.0.1/x.png',
      'https://172.31.255.255/x.png',
      'https://192.168.1.1/x.png',
      // The one that matters most: AWS/GCP/Azure instance metadata.
      'https://169.254.169.254/latest/meta-data/',
      'https://0.0.0.0/x.png',
      'https://[::1]/x.png',
      'https://[fc00::1]/x.png',
      'https://[fd12:3456::1]/x.png',
      'https://[fe80::1]/x.png',
      // IPv4-mapped IPv6 reaches the same IPv4 destination.
      'https://[::ffff:169.254.169.254]/x.png',
      'https://[::ffff:127.0.0.1]/x.png'
    ]) {
      expect(checkImageUrl(url).ok, `${url} must be refused`).toBe(false)
    }
  })

  it('accepts a public IP literal — the rule is the range, not the shape', () => {
    expect(checkImageUrl('https://93.184.216.34/x.png').ok).toBe(true)
    const verdict = checkImageUrl('https://93.184.216.34/x.png')
    expect(verdict.ok && verdict.hostIsAddress).toBe(true)
  })

  it('rejects a malformed string', () => {
    for (const raw of ['', '   ', 'not a url', 'https://', '///a.png', 'https:// spaces.com/a.png']) {
      expect(checkImageUrl(raw).ok, `${JSON.stringify(raw)} must be refused`).toBe(false)
    }
  })

  it('rejects embedded credentials, which nothing legitimate needs', () => {
    expect(checkImageUrl('https://user:pass@cdn.example.com/a.png').ok).toBe(false)
  })

  it('rejects an absurdly long URL before anything tries to store it', () => {
    const long = `https://cdn.example.com/${'a'.repeat(MAX_IMAGE_URL_LENGTH)}.png`
    expect(checkImageUrl(long).ok).toBe(false)
  })

  it('ignores a trailing dot on the host, which is the same host', () => {
    // `localhost.` resolves exactly as `localhost` does, so the check has to
    // normalise it away rather than treat it as an unfamiliar public name.
    expect(checkImageUrl('https://localhost./a.png').ok).toBe(false)
  })

  it('exposes the same verdict as a boolean for callers that only need one', () => {
    expect(isFetchableImageUrl('https://cdn.example.com/a.png')).toBe(true)
    expect(isFetchableImageUrl('http://169.254.169.254/')).toBe(false)
  })
})

describe('isBlockedAddress', () => {
  it('blocks every reserved range a DNS answer could land in', () => {
    for (const address of [
      '127.0.0.1',
      '10.255.255.254',
      '172.20.30.40',
      '192.168.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1', // carrier-grade NAT
      '224.0.0.1', // multicast
      '::1',
      '::',
      'fc00::1',
      'fdff::1',
      'fe80::abcd',
      'ff02::1'
    ]) {
      expect(isBlockedAddress(address), `${address} must be blocked`).toBe(true)
    }
  })

  it('allows ordinary public addresses', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1::1']) {
      expect(isBlockedAddress(address), `${address} must be allowed`).toBe(false)
    }
  })

  it('blocks anything it cannot classify, rather than assuming it is safe', () => {
    // A resolver answer this function cannot parse is not evidence of safety.
    for (const address of ['', 'nonsense', '10.0.0', '1.2.3.4.5', '12345::x']) {
      expect(isBlockedAddress(address), `${address} must be blocked`).toBe(true)
    }
  })

  it('tolerates the zone and bracket forms a resolver or URL may hand over', () => {
    expect(isBlockedAddress('[fe80::1%eth0]')).toBe(true)
    expect(isBlockedAddress('[2606:2800:220:1::1]')).toBe(false)
  })
})

describe('isAddressLiteral', () => {
  it('separates literals from names', () => {
    expect(isAddressLiteral('10.0.0.1')).toBe(true)
    expect(isAddressLiteral('fc00::1')).toBe(true)
    expect(isAddressLiteral('cdn.example.com')).toBe(false)
    // Not a dotted quad in the strict sense, so it is treated as a name — and
    // DNS resolution is what then decides it (see the module comment).
    expect(isAddressLiteral('2130706433')).toBe(false)
  })
})

describe('parseRenderUrls', () => {
  it('turns newline-separated text into an array', () => {
    const parsed = parseRenderUrls('https://cdn.example.com/a.png\nhttps://cdn.example.com/b.png')

    expect(parsed).toEqual({
      ok: true,
      urls: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png']
    })
  })

  it('trims each line and drops blank ones', () => {
    // What pasting a column out of a spreadsheet actually looks like.
    const parsed = parseRenderUrls(
      '\n  https://cdn.example.com/a.png  \r\n\n\thttps://cdn.example.com/b.png\n   \n'
    )

    expect(parsed).toEqual({
      ok: true,
      urls: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png']
    })
  })

  it('reads an empty textarea as "no renders", not as an error', () => {
    expect(parseRenderUrls('')).toEqual({ ok: true, urls: [] })
    expect(parseRenderUrls('\n  \n')).toEqual({ ok: true, urls: [] })
  })

  it('collapses a duplicated line to one render', () => {
    const parsed = parseRenderUrls(
      'https://cdn.example.com/a.png\nhttps://cdn.example.com/a.png'
    )
    expect(parsed).toEqual({ ok: true, urls: ['https://cdn.example.com/a.png'] })
  })

  it('rejects the whole submission when one line is not usable, and says which', () => {
    const parsed = parseRenderUrls(
      ['https://cdn.example.com/a.png', 'http://localhost:5432/x', 'https://cdn.example.com/c.png'].join(
        '\n'
      )
    )

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    // By line number: "one of your three URLs is wrong" is not actionable.
    expect(parsed.reason).toMatch(/^Line 2:/)
  })

  it('enforces the cap, so a paste accident cannot balloon a page', () => {
    const overCap = Array.from(
      { length: MAX_RENDER_IMAGES + 1 },
      (_, index) => `https://cdn.example.com/${index}.png`
    ).join('\n')

    const parsed = parseRenderUrls(overCap)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toMatch(new RegExp(`${MAX_RENDER_IMAGES}`))
  })

  it('accepts exactly the cap', () => {
    const atCap = Array.from(
      { length: MAX_RENDER_IMAGES },
      (_, index) => `https://cdn.example.com/${index}.png`
    ).join('\n')

    const parsed = parseRenderUrls(atCap)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.urls).toHaveLength(MAX_RENDER_IMAGES)
  })
})
