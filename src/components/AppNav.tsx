'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Logo } from '@/components/Logo'
import { activeHref, type Destination, type NavIcon } from '@/components/nav'

/**
 * The two presentations of one destination list.
 *
 * A client component only because the active tab depends on the current path,
 * and `usePathname` is the only thing that knows it during a client-side
 * navigation — a server-read pathname would be a render behind. Nothing else in
 * here is interactive: the destinations arrive as plain serialisable data from
 * the server layout, so no bigint and no service ever crosses this boundary.
 */

/**
 * Icons, drawn rather than installed. No icon library: five glyphs do not
 * justify a dependency, and every one of them has to stay legible at 20px on a
 * 360px phone, which rules out anything detailed. One stroke weight, round
 * caps, 24-unit grid.
 */
function NavGlyph({ name, className = '' }: { name: NavIcon; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className
  }

  switch (name) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3.5 10.5 12 3.5l8.5 7" />
          <path d="M5.5 9.8V20.5h13V9.8" />
        </svg>
      )
    case 'projects':
      // The mark's silhouette, stroked: two blocks on one baseline.
      return (
        <svg {...common}>
          <path d="M4 20.5V5.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v15" />
          <path d="M11 20.5V10h8a1 1 0 0 1 1 1v9.5" />
          <path d="M2.5 20.5h19" />
          <path d="M6.75 8.5h1.5M6.75 12.5h1.5M14.5 14h1.5" />
        </svg>
      )
    case 'arrears':
      // Money owed today, not a document: a warning, because that is what this
      // list is for.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.75" />
          <path d="M12 7.25v5.25" />
          <path d="M12 16.25h.01" />
        </svg>
      )
    case 'dashboard':
      // The buyer's contract: a statement with a schedule on it.
      return (
        <svg {...common}>
          <rect x="4.25" y="3.25" width="15.5" height="17.5" rx="2" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </svg>
      )
    case 'profile':
      return (
        <svg {...common}>
          <circle cx="12" cy="8.25" r="3.5" />
          <path d="M5 20.25a7 7 0 0 1 14 0" />
        </svg>
      )
  }
}

export function AppNav({ destinations }: { destinations: Destination[] }) {
  // `usePathname` can be null during the very first render of a statically
  // optimised page; '/' is the safe read (Home is exact-match, so at worst one
  // tab is briefly lit that should not be).
  const pathname = usePathname() ?? '/'
  const active = activeHref(pathname, destinations)

  return (
    <>
      {/*
        Top bar. The brand half shows on every width — below `sm:` it is the only
        place the mark appears once the login page is behind you, and a screen
        with a bottom bar and no header reads like a web page rather than an app.
        The destinations half appears from `sm:`, where the bottom bar hides.
      */}
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex min-h-11 items-center" aria-label="PreCon Africa — home">
            <Logo size={24} withWordmark />
          </Link>

          <nav className="ml-auto hidden sm:flex" aria-label="Primary">
            {destinations.map((destination) => {
              const isActive = active === destination.href
              return (
                <Link
                  key={destination.href}
                  href={destination.href}
                  aria-current={isActive ? 'page' : undefined}
                  className={`flex min-h-11 items-center gap-2 px-3 text-sm font-semibold transition-colors ${
                    isActive ? 'text-navy-900' : 'text-muted hover:text-navy-900'
                  }`}
                >
                  <NavGlyph name={destination.icon} className="h-[18px] w-[18px]" />
                  {destination.label}
                </Link>
              )
            })}
          </nav>
        </div>
      </header>

      {/*
        Bottom bar, mobile only. Fixed, `surface` over a top `line` border, and
        padded by the safe-area inset so the labels clear the home indicator on
        an iPhone rather than sitting under it. The page's own bottom padding
        (see AppShell) accounts for the same two numbers.
      */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface sm:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="mx-auto flex max-w-5xl">
          {destinations.map((destination) => {
            const isActive = active === destination.href
            return (
              <li key={destination.href} className="flex-1">
                <Link
                  href={destination.href}
                  aria-current={isActive ? 'page' : undefined}
                  // h-14 (56px) clears the 44px tap-target floor with room for
                  // the label under the icon.
                  className={`flex h-14 flex-col items-center justify-center gap-1 ${
                    isActive ? 'text-navy-900' : 'text-muted'
                  }`}
                >
                  {/* teal-100 is DESIGN.md's "accent tint behind icons"; it is
                      what makes the active tab findable at a glance, since
                      navy-vs-muted alone is a weak signal on a small screen. */}
                  <span
                    className={`flex h-6 w-10 items-center justify-center rounded-full ${
                      isActive ? 'bg-teal-100' : ''
                    }`}
                  >
                    <NavGlyph name={destination.icon} className="h-5 w-5" />
                  </span>
                  <span className="text-[11px] font-semibold leading-none">
                    {destination.label}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </>
  )
}
