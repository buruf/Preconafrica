import zlib from 'node:zlib'
import type { InvoiceProps } from '@/server/pdf/InvoiceDocument'
import type { StatementProps } from '@/server/pdf/StatementDocument'
import type { ReceiptProps } from '@/server/pdf/ReceiptDocument'
import type { FloorPlanProps } from '@/server/pdf/FloorPlanDocument'

/**
 * Fixtures for the four documents, plus enough of a PDF reader to assert
 * against what actually came out — so the document tests render from local data
 * and never from the database. Not a `.test.ts`, so vitest imports this rather
 * than collecting it (see `include` in vitest.config).
 */

/**
 * @react-pdf writes its page content as Flate-compressed streams, and text
 * inside them as hex strings in `TJ` arrays — split at kerning pairs, which is
 * why the pieces of one array are joined back together before anything is
 * matched against them.
 *
 * The bytes are WinAnsi, which agrees with latin1 everywhere except 0x80–0x9F,
 * the range holding the typographic characters these documents actually use.
 * Only those are mapped back; anything else would be a character the standard
 * faces cannot print anyway.
 */
const WINANSI_HIGH: Record<string, string> = {
  '\x91': '‘',
  '\x92': '’',
  '\x93': '“',
  '\x94': '”',
  '\x96': '–',
  '\x97': '—'
}

export function extractPdfText(buffer: Buffer): string {
  const latin = buffer.toString('latin1')
  const streams: string[] = []

  const streamStart = /stream\r?\n?/g
  let marker: RegExpExecArray | null
  while ((marker = streamStart.exec(latin))) {
    const from = marker.index + marker[0].length
    const to = latin.indexOf('endstream', from)
    if (to < 0) continue
    const raw = buffer.subarray(from, to)
    try {
      streams.push(zlib.inflateSync(raw).toString('latin1'))
    } catch {
      // Not every stream is compressed (or text at all) — skip what will not
      // inflate rather than failing the read.
    }
  }

  const runs: string[] = []
  const show = /\[((?:\s*<[0-9a-fA-F]*>|\s*-?[\d.]+)*)\s*\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*Tj/g
  for (const content of streams) {
    let op: RegExpExecArray | null
    while ((op = show.exec(content))) {
      if (op[1] !== undefined) {
        runs.push(
          [...op[1].matchAll(/<([0-9a-fA-F]*)>/g)]
            .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'))
            .join('')
        )
      } else if (op[2] !== undefined) {
        runs.push(op[2])
      }
    }
  }

  // Runs are separate text nodes and separate laid-out lines, so they are joined
  // with a space and the whitespace collapsed: a phrase reads the same whether
  // the layout kept it in one run or split it across two.
  return runs
    .join(' ')
    .replace(/[\x80-\x9f]/g, (char) => WINANSI_HIGH[char] ?? char)
    .replace(/\s+/g, ' ')
}

/** CRC-32 as PNG defines it, so the chunks below are genuinely valid. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/**
 * A genuinely valid 8-bit RGB PNG of `width`×`height`, with deliberately
 * incompressible pixels so the encoded size is realistic rather than a few
 * hundred bytes of run-length. It has to be really valid: @react-pdf's decoder
 * throws inside a zlib callback on a bad CRC, which takes the process down
 * rather than failing a test.
 *
 * `makePng` below is this at `width === height`; this rectangular form exists
 * for the orientation tests, which need a real IHDR that `sharp` (via
 * `toPdfImageWithSize`) can actually read a non-square size off of, not just a
 * fixture whose `width`/`height` fields are set by hand.
 */
export function makeRectPng(width: number, height: number, seed = 1): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1))
  let state = seed
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < width * 3; x += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      raw[rowStart + 1 + x] = (state >>> 16) & 0xff
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** `makeRectPng` at `side`×`side` — the shape every existing fixture wants. */
export function makePng(side: number, seed = 1): Buffer {
  return makeRectPng(side, side, seed)
}

/**
 * A logo of about the size a real one is — roughly 10 kB, which is the figure
 * the letterhead change was costed against. 56×56 is also about what the 46pt
 * masthead slot needs at print resolution.
 */
export const LOGO_PNG = makePng(56)

/**
 * The page's own `/MediaBox`, in points — what a reader's PDF viewer actually
 * lays the page out as, and the only honest way to assert a page-orientation
 * decision. It lives in the page object's own dictionary, never inside a
 * Flate-compressed content stream, so unlike `extractPdfText` this needs no
 * inflate — a plain string search finds it.
 */
export function extractPageSize(buffer: Buffer): { width: number; height: number } {
  const latin = buffer.toString('latin1')
  const match = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(latin)
  if (!match) throw new Error('No /MediaBox found in this PDF')
  const [x0, y0, x1, y1] = match.slice(1, 5).map(Number)
  return { width: x1 - x0, height: y1 - y0 }
}

export const INVOICE: InvoiceProps = {
  number: 'INV-000042',
  issuedAt: new Date('2026-08-12T09:30:00Z'),
  orgName: 'Sunrise Developments',
  logo: null,
  projectName: 'Riverside Court',
  projectLocation: 'Riverside Drive, Nairobi',
  unitName: '4C',
  buyerName: 'Joseph Otieno',
  buyerPhone: '+254733222111',
  buyerEmail: 'joseph@buyer.test',
  buyerAddress: 'Ngong Road, Nairobi',
  currency: 'KES',
  sequence: 2,
  termMonths: 36,
  dueDate: new Date('2026-03-10T00:00:00Z'),
  amountDueMinor: 18333333n,
  amountPaidMinor: 11666667n,
  status: 'OVERDUE'
}

export const STATEMENT: StatementProps = {
  number: 'STMT-000009',
  orgName: 'Sunrise Developments',
  logo: null,
  projectName: 'Riverside Court',
  projectLocation: 'Riverside Drive, Nairobi',
  unitName: '4C',
  heroImage: null,
  buyerName: 'Joseph Otieno',
  buyerPhone: '+254733222111',
  currency: 'KES',
  planType: 'INSTALLMENTS',
  termMonths: 24,
  priceMinor: 14500000000n,
  depositMinor: 500000000n,
  fee: { mode: 'PERCENT', bps: 1000, fixedMinor: 0n },
  feeMinor: 1400000000n,
  signedAt: new Date('2026-02-01T00:00:00Z'),
  expectedCompletion: new Date('2028-06-30T00:00:00Z'),
  entries: [
    {
      sequence: 0,
      dueDate: new Date('2026-02-01T00:00:00Z'),
      amountDueMinor: 500000000n,
      amountPaidMinor: 500000000n,
      status: 'PAID'
    },
    {
      sequence: 1,
      dueDate: new Date('2026-03-01T00:00:00Z'),
      amountDueMinor: 641666666n,
      amountPaidMinor: 0n,
      status: 'OVERDUE'
    }
  ],
  totalMinor: 15900000000n,
  paidToDateMinor: 500000000n,
  balanceMinor: 15400000000n
}

export const RECEIPT: ReceiptProps = {
  number: 'RCPT-000114',
  orgName: 'Sunrise Developments',
  logo: null,
  projectName: 'Riverside Court',
  unitName: '4C',
  buyerName: 'Joseph Otieno',
  currency: 'KES',
  amountMinor: 11666667n,
  receivedAt: new Date('2026-03-12T00:00:00Z'),
  method: 'BANK_TRANSFER',
  reference: 'TRF-0114',
  allocations: [
    { sequence: 0, dueDate: new Date('2026-02-01T00:00:00Z'), amountMinor: 3333333n },
    { sequence: 2, dueDate: new Date('2026-03-10T00:00:00Z'), amountMinor: 8333334n }
  ],
  balanceMinor: 15400000000n,
  voided: false,
  voidReason: null
}

/**
 * The floor plan, which is the odd one out: no number, no buyer, no currency
 * and — deliberately — no price anywhere in the props. See `FloorPlanDocument`.
 *
 * The size deliberately carries decimals, because "245.00" is the shape a
 * `Decimal(10,2)` stringifies to and a naive "is there money on this page"
 * assertion would trip over it.
 */
export const FLOOR_PLAN: FloorPlanProps = {
  orgName: 'Sunrise Developments',
  projectName: 'Riverside Court',
  projectLocation: 'Riverside Drive, Nairobi',
  expectedCompletion: new Date('2028-06-30T00:00:00Z'),
  unitName: '4C',
  floor: 4,
  bedrooms: 3,
  sizeSqm: '245.00',
  logo: null,
  plan: null,
  planOnFile: false
}
