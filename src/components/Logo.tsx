/**
 * The PreCon Africa mark.
 *
 * Two blocks on one baseline — the taller in `teal-500`, the shorter in
 * `navy-900` — with window notches knocked out of both. The notches are real
 * holes rather than page-coloured rectangles (`fillRule="evenodd"`, windows
 * drawn as subpaths of the same path as the tower), so the mark sits on the
 * navy login panel, on `surface` and on `page` without a halo.
 *
 * Inline SVG, never an <img>: it costs no request, it is crisp at any size, and
 * it renders before the first paint on a phone with two bars of signal. It is
 * drawn on a 24-unit grid and has to read at 24px in the nav bar and at 40px on
 * the login page, which is why there are six windows and not sixteen — at 24px
 * a 2-unit window is two device pixels, and anything finer turns to grey mush.
 *
 * The same geometry is duplicated in src/app/icon.svg (the favicon). Next
 * serves that file from the filesystem, so it cannot import this component;
 * if the shape changes here, change it there.
 */
export function Logo({
  size = 24,
  withWordmark = false,
  className = ''
}: {
  /** Height and width of the mark itself, in px. 24 in nav, 40 on login. */
  size?: number
  /** Renders "PreCon Africa" beside the mark, scaled off `size`. */
  withWordmark?: boolean
  className?: string
}) {
  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      // Decorative when the wordmark is beside it (the text carries the name);
      // labelled when it stands alone.
      role={withWordmark ? undefined : 'img'}
      aria-hidden={withWordmark ? true : undefined}
      aria-label={withWordmark ? undefined : 'PreCon Africa'}
      className="shrink-0"
    >
      {/* Taller tower, teal. 2 windows across, 3 down. */}
      <path
        fill="#21A0A0"
        fillRule="evenodd"
        d="M2.5 4.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1V21h-8V4.5Z
           M4.5 6.5h2v2h-2v-2Z M7.5 6.5h2v2h-2v-2Z
           M4.5 10.5h2v2h-2v-2Z M7.5 10.5h2v2h-2v-2Z
           M4.5 14.5h2v2h-2v-2Z M7.5 14.5h2v2h-2v-2Z"
      />
      {/* Shorter block, navy. Starts lower and runs to the same baseline, so the
          two read as one building rather than as two unrelated bars. */}
      <path
        fill="#0E2A47"
        fillRule="evenodd"
        d="M12.5 10a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v11h-9V10Z
           M14.5 12h2v2h-2v-2Z M17.5 12h2v2h-2v-2Z
           M14.5 16h2v2h-2v-2Z M17.5 16h2v2h-2v-2Z"
      />
    </svg>
  )

  if (!withWordmark) return className ? <span className={className}>{mark}</span> : mark

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {mark}
      <span
        className="font-semibold leading-none tracking-tight text-navy-900"
        // Scaled off the mark rather than fixed, so one prop sizes the lockup.
        style={{ fontSize: Math.round(size * 0.62) }}
      >
        PreCon <span className="text-teal-500">Africa</span>
      </span>
    </span>
  )
}
