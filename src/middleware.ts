/**
 * Deliberately inert. This is decoration, not a security boundary.
 *
 * Exporting Auth.js's `auth` as the middleware without an `authorized`
 * callback protects nothing: it populates the request's auth context and lets
 * every matched request through, signed in or not. That is on purpose — every
 * page and route in this app calls its own guard (requireUser / requireStaff /
 * requireAdmin / requireBuyer from @/server/session, and an explicit session
 * check in the API routes), which is what actually enforces access. A page
 * that forgets its guard is not saved by anything here.
 *
 * It is kept rather than deleted because removing it changes what runs at the
 * edge for these paths — a behavioural change with no upside this late — and
 * because it is where a future `authorized` callback would go. The matcher is
 * kept complete for that reason: /team was missing, and a matcher that
 * silently omits a protected path is exactly the kind of thing someone would
 * later mistake for an intentional exemption. It grants no access on its own.
 */
export { auth as middleware } from '@/server/auth'

export const config = {
  matcher: [
    '/projects/:path*',
    '/sales/:path*',
    '/arrears/:path*',
    '/team/:path*',
    '/dashboard/:path*',
    // The staff change-password page. The buyer's copy lives under
    // /dashboard/account/password and is already covered by the line above.
    // Listed for the same reason /team was: an incomplete matcher reads like
    // an intentional exemption to whoever finds it next, and this grants no
    // access either way.
    '/account/:path*',
    // The role-aware home screen and the profile page, both behind
    // `requireUser`. Added for the same completeness reason as /team and
    // /account: this grants no access either way, and a matcher that omits a
    // signed-in path reads like an intentional exemption.
    '/',
    '/profile/:path*'
  ]
}
