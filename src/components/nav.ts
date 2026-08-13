// `import type` only — erased at compile time, so this module (which a client
// component imports) never pulls @/server/session's Prisma client into the
// browser bundle.
import type { Role } from '@/server/session'

/**
 * The destinations, defined once.
 *
 * Both presentations — the bottom tab bar on mobile and the top bar from `sm:`
 * — render this same array. That is the whole reason it exists as data rather
 * than as two lists of <Link>s: the previous shell hand-wrote its nav in the
 * staff layout and again in the buyer layout, and the two had already drifted
 * (buyers had no route to their own profile because there was no profile). A
 * route is now either in this array for a role or it is not reachable from any
 * bar for that role, in both presentations, on every screen width.
 */

export type NavIcon = 'home' | 'projects' | 'arrears' | 'dashboard' | 'profile'

export interface Destination {
  href: string
  label: string
  icon: NavIcon
  /**
   * Extra path prefixes this tab stays lit for — the routes you reach *through*
   * it. Without them a staff member opening a sale from the inventory would
   * watch every tab go dark, which reads as "you have navigated out of the app".
   *
   * Longest match wins across the whole array (see `activeHref`), which is what
   * lets Profile own `/dashboard/account` while Dashboard owns `/dashboard`.
   */
  owns?: string[]
}

const HOME: Destination = { href: '/', label: 'Home', icon: 'home' }

/**
 * Profile owns the change-password pages (both roles' copies) and `/team`.
 *
 * Team is deliberately *not* a fifth tab. DESIGN.md caps the bar at four
 * destinations for staff and three for a buyer (Projects is staff-only);
 * adding a fifth for one role would make the admin's bar a
 * different shape from the agent's on the same screens, and Team is an
 * occasional org-administration surface (add an agent, set the letterhead
 * logo), not somewhere anyone navigates several times a day. Profile is
 * already "you and your organisation", so it links there — and because it is
 * a link on a page rather than a tab, it is identically reachable from both
 * presentations, which is the invariant this module exists to hold.
 */
const PROFILE: Destination = {
  href: '/profile',
  label: 'Profile',
  icon: 'profile',
  owns: ['/account', '/team', '/dashboard/account']
}

export function destinationsFor(role: Role): Destination[] {
  if (role === 'BUYER') {
    return [HOME, { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' }, PROFILE]
  }

  return [
    HOME,
    // A sale is opened from an inventory row far more often than from the
    // arrears list, so /sales lives under Projects.
    { href: '/projects', label: 'Projects', icon: 'projects', owns: ['/sales'] },
    { href: '/arrears', label: 'Arrears', icon: 'arrears' },
    PROFILE
  ]
}

/**
 * Which destination the current path belongs to, by longest matching prefix.
 *
 * Longest-match rather than first-match because the prefixes genuinely nest:
 * `/dashboard/account/password` is under Dashboard's `/dashboard` and under
 * Profile's `/dashboard/account`, and a buyer changing their password is on the
 * profile branch. Returns null when nothing owns the path, which is a legitimate
 * state (a 404, a route nobody has claimed yet) and must leave every tab
 * unlit rather than guessing.
 */
export function activeHref(pathname: string, destinations: Destination[]): string | null {
  let bestHref: string | null = null
  let bestLength = -1

  for (const destination of destinations) {
    for (const prefix of [destination.href, ...(destination.owns ?? [])]) {
      // '/' prefixes everything, so Home is exact-match only — otherwise it
      // would win nothing (length 1) but still light up on every route where
      // no other destination matched.
      const matches =
        prefix === '/'
          ? pathname === '/'
          : pathname === prefix || pathname.startsWith(`${prefix}/`)

      if (matches && prefix.length > bestLength) {
        bestHref = destination.href
        bestLength = prefix.length
      }
    }
  }

  return bestHref
}
