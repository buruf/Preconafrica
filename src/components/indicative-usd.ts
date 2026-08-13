/**
 * The `≈ USD 96,154 (indicative)` second line the mockup shows under a price.
 *
 * ─── READ THIS BEFORE IMPORTING THIS MODULE ──────────────────────────────────
 *
 * These rates are APPROXIMATE and HAND-MAINTAINED. Nobody quotes them, nobody
 * agrees to them, and NOTHING THAT DECIDES MONEY READS THEM. They exist so a
 * diaspora buyer scrolling a Lagos price list has a rough sense of scale, and
 * for no other purpose.
 *
 * Concretely, this module must never be reachable from:
 *
 *   - `src/domain/**`   — the money core: schedules, allocation, currency
 *   - `src/server/**`   — services, PDFs, notifications
 *   - `prisma/**`       — the seed
 *   - the write paths under `src/app/**` — every `actions.ts` (a `'use server'`
 *     file; the sell flow's is what calls `createSale`) and every `route.ts`.
 *     In this app the route handlers and the server actions live under `src/app`
 *     beside the screens, not under `src/server`, so listing `src/server` alone
 *     would leave every money write in the codebase uncovered. The rest of
 *     `src/app` — pages and layouts — is presentation and may read this module.
 *
 * `src/components/__tests__/indicative-usd.test.ts` enforces exactly that by
 * walking those trees, in the same shape as `domain-purity.test.ts`. It lives
 * in `src/components/` — the presentation layer — rather than in `src/domain/`
 * for the same reason: a currency conversion sitting next to `formatMinor` is
 * one careless import away from being treated as one.
 *
 * It deliberately imports nothing at all. Not even `formatMinor` — a
 * three-line grouping of whole dollars is cheaper than a dependency edge
 * pointing from here into the money core, in either direction.
 *
 * If a real quote is ever needed, it needs a rate provider, a timestamp, a
 * stored rate on the row it priced, and a conversation about who bears the
 * movement. It does not need this file.
 */

/**
 * Minor units of the local currency to one US dollar — an integer, so the whole
 * calculation below is BigInt and no float ever touches an amount that came out
 * of a money column, presentational or not.
 *
 * Rates rounded hard, as at 2026-08-12. They will be wrong by a few percent
 * within weeks and that is fine; "(indicative)" is on every line they produce.
 * Update them by hand when they get embarrassing.
 *
 * Note the zero-decimal currencies: for RWF, UGX, XOF, XAF and DJF a minor unit
 * *is* the major unit, so the figure here is the plain rate. Getting that wrong
 * would be a 100x error, which is why `SUPPORTED_CURRENCIES` in
 * `@/domain/currency` carries the exponents and why these are written out one
 * per line with the major-unit rate in the comment.
 *
 * USD is deliberately absent: a price already in dollars needs no dollar
 * equivalent, and printing `≈ USD 96,154 (indicative)` under `USD 96,154` would
 * read as a bug. Any currency missing from this table renders nothing.
 */
const MINOR_UNITS_PER_USD: Readonly<Record<string, bigint>> = Object.freeze({
  NGN: 150_800n, // ≈ ₦1,508
  KES: 12_900n, //  ≈ KSh 129
  GHS: 1_050n, //   ≈ GH₵ 10.50
  ZAR: 1_780n, //   ≈ R 17.80
  EGP: 4_850n, //   ≈ E£ 48.50
  MAD: 900n, //     ≈ 9.00 dirham
  TZS: 260_000n, // ≈ TSh 2,600
  RWF: 1_320n, //   ≈ 1,320 francs   (zero-decimal)
  UGX: 3_650n, //   ≈ 3,650 shillings (zero-decimal)
  XOF: 570n, //     ≈ 570 francs     (zero-decimal)
  XAF: 570n, //     ≈ 570 francs     (zero-decimal)
  DJF: 178n, //     ≈ 178 francs     (zero-decimal)
  EUR: 86n, //      ≈ €0.86
  GBP: 74n //       ≈ £0.74
})

/** Whether a second line can be drawn for this currency at all. */
export function hasIndicativeUsdRate(currency: string): boolean {
  return currency.trim().toUpperCase() in MINOR_UNITS_PER_USD
}

/**
 * Whole US dollars, to the nearest dollar, or null when there is no rate.
 *
 * Whole dollars on purpose: cents on an approximation are a false precision,
 * and a reader who sees `≈ USD 96,153.85` will reasonably assume somebody
 * calculated it.
 *
 * BigInt throughout, rounded half-up by `(2a + r) / 2r` rather than by
 * `Math.round`, because the input is a minor-unit amount that may sit far above
 * `Number.MAX_SAFE_INTEGER` in NGN or UGX — the same ceiling `formatMinor`
 * documents. Negative amounts return null: nothing this line sits under is ever
 * negative, and silently printing `≈ USD -0` would be worse than printing
 * nothing.
 */
export function indicativeUsdWhole(amountMinor: bigint, currency: string): bigint | null {
  if (amountMinor < 0n) return null

  const rate = MINOR_UNITS_PER_USD[currency.trim().toUpperCase()]
  if (rate === undefined) return null

  return (2n * amountMinor + rate) / (2n * rate)
}

/**
 * The whole line, wording included: `≈ USD 96,154 (indicative)`.
 *
 * One function rather than a template at each call site, so the two screens
 * that show it cannot end up labelling it differently — and so that "(indicative)"
 * cannot be dropped by someone tidying up a layout. Null means render nothing:
 * no crash, and no `≈ USD 0`.
 */
export function indicativeUsdLine(amountMinor: bigint, currency: string): string | null {
  const whole = indicativeUsdWhole(amountMinor, currency)
  if (whole === null) return null

  // Grouping only — no `style: 'currency'`, because 'USD 96,154' is the WinAnsi
  // -safe spelling this product uses everywhere (see DESIGN.md on PDF fonts) and
  // because '$' would read as a price rather than as an estimate.
  return `≈ USD ${new Intl.NumberFormat('en-US').format(whole)} (indicative)`
}
