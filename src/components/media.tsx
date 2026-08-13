import type { ReactNode } from 'react'

/**
 * Every image on every page goes through these two components, and every empty
 * slot goes through the same placeholder. Hand-rolling "a grey box where the
 * photo would be" per page is how six pages end up with six different boxes and
 * one page ends up with a collapsed layout instead.
 *
 * Plain `<img loading="lazy" />`, deliberately not `next/image`: these hosts are
 * arbitrary and user-supplied, and `next/image` would demand every one of them
 * be listed in `next.config.mjs` — a config edit per developer who pastes a URL
 * from a new CDN, which is not a product. Lazy loading is not decoration here:
 * buyers open the sale page on mobile data, and the renders strip is the
 * heaviest thing on it.
 */

export type MediaKind = 'building' | 'layout' | 'render'

/** What the placeholder says belongs in the space. */
const LABEL: Record<MediaKind, string> = {
  building: 'Building photo',
  layout: 'Unit layout',
  render: 'Unit render'
}

/**
 * A fixed ratio per kind, so a missing image reserves exactly the space the
 * real one will occupy and the page does not reflow when one is set. Without
 * this the placeholder collapses to nothing and the layout is a different
 * layout depending on whether an admin has got round to pasting a URL.
 */
const RATIO: Record<MediaKind, string> = {
  building: 'aspect-[16/9]',
  layout: 'aspect-[4/3]',
  render: 'aspect-[4/3]'
}

/** A small square glyph, drawn rather than imported: a picture frame outline. */
function FrameGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-6 w-6 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M4 17l5-5 4 4 2.5-2.5L20 17" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * The empty state. Bordered, muted, dashed, and labelled with what is missing —
 * so an admin looking at their own inventory can see that the building photo is
 * the thing to go and set, rather than wondering whether the page is broken.
 */
export function MediaPlaceholder({
  kind,
  label,
  className = ''
}: {
  kind: MediaKind
  /** Overrides the default wording, e.g. "No renders yet". */
  label?: string
  className?: string
}) {
  return (
    <div
      className={`flex ${RATIO[kind]} w-full flex-col items-center justify-center gap-1.5 rounded-btn border border-dashed border-line bg-page ${className}`}
    >
      <FrameGlyph />
      <span className="px-2 text-center text-xs font-medium text-muted">
        {label ?? LABEL[kind]}
      </span>
    </div>
  )
}

/**
 * The URL, or the placeholder. One component, so no caller has to remember the
 * null branch — and so the day uploads replace pasted URLs, the only thing that
 * changes is where `src` comes from.
 *
 * `alt` is required and must describe the subject ("Sunrise Heights, Lekki
 * Phase 1", "Floor plan for unit 3B") rather than announce itself as an image:
 * a buyer on a screen reader wants to know which unit's plan failed to load.
 */
export function MediaImage({
  kind,
  src,
  alt,
  label,
  className = ''
}: {
  kind: MediaKind
  src: string | null | undefined
  alt: string
  label?: string
  className?: string
}) {
  if (!src) return <MediaPlaceholder kind={kind} label={label} className={className} />

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      // The ratio box is on the image itself, so a URL that 404s leaves a
      // correctly sized gap instead of shifting everything below it. `object-cover`
      // because a developer's photo will be any ratio at all and letterboxing an
      // inventory banner looks like a bug.
      className={`${RATIO[kind]} w-full rounded-btn border border-line bg-page object-cover ${className}`}
    />
  )
}

/**
 * The unit's own imagery — floor plan and renders — as one block, used verbatim
 * by the staff sale page, the buyer dashboard, the sell form and its confirm
 * step. Four surfaces, one arrangement: what the buyer sees while deciding is
 * exactly what they see afterwards, which is the whole point of showing it on
 * the confirm step at all.
 *
 * Both halves always render, placeholder included, because "there is no floor
 * plan for this unit yet" is information a buyer signing a contract should have
 * rather than an absence they cannot notice.
 */
export function UnitImagery({
  unitName,
  projectName,
  layoutImageUrl,
  renderImageUrls,
  heading
}: {
  unitName: string
  projectName: string
  layoutImageUrl: string | null
  renderImageUrls: string[]
  heading?: string
}) {
  const subject = `unit ${unitName}, ${projectName}`

  return (
    <div>
      {heading ? <h2 className="mb-2 font-semibold">{heading}</h2> : null}
      {/* One column below `sm:`, so on a 360px phone the plan and each render are
          full-width and legible rather than three thumbnails and a sideways
          scroll. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,16rem)_1fr]">
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">
            Layout
          </p>
          <MediaImage
            kind="layout"
            src={layoutImageUrl}
            alt={`Floor plan for ${subject}`}
            className="object-contain"
          />
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">
            Renders
          </p>
          <MediaGallery urls={renderImageUrls} alt={`Artist's impression of ${subject}`} />
        </div>
      </div>
    </div>
  )
}

/**
 * The renders, several per unit. A responsive grid rather than a horizontal
 * scroller: below `sm:` it is one column — full-width images a buyer can
 * actually see on a phone — and above it two or three across. A scroll strip
 * hides everything past the first image behind a gesture nobody performs, and
 * risks the page itself scrolling sideways on a 360px screen.
 */
export function MediaGallery({
  urls,
  alt,
  heading,
  emptyLabel = 'No renders yet'
}: {
  urls: string[]
  /** Prefix; each image gets "… (2 of 4)" appended so the alts are distinct. */
  alt: string
  heading?: ReactNode
  emptyLabel?: string
}) {
  return (
    <div>
      {heading}
      {urls.length === 0 ? (
        <MediaPlaceholder kind="render" label={emptyLabel} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {urls.map((url, index) => (
            <li key={url}>
              <MediaImage
                kind="render"
                src={url}
                alt={
                  urls.length > 1 ? `${alt} (${index + 1} of ${urls.length})` : alt
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
