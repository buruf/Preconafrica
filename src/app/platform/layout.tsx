import Link from 'next/link'
import { Logo } from '@/components/Logo'
import { requirePlatformAdminOrNull } from '@/server/session'

/**
 * The console's own chrome: a plain header and nothing else.
 *
 * Deliberately not the app's shell. There is no bottom tab bar and no
 * Projects/Arrears/Profile — those belong to a developer working inside one
 * organisation, and every one of them would 404 or redirect for an operator
 * who has none. Sharing the shell would also blur the line this whole feature
 * exists to draw.
 *
 * The header reads the session only to decide what to *show*. It guards
 * nothing: a layout cannot protect the pages beneath it — each one calls
 * `requirePlatformAdmin` for itself, and so does every action. Hiding the links
 * from a signed-out visitor is about not offering doors that lead straight
 * back to the login screen, which is what the console did when it first
 * shipped: /platform/login carried "Activity" and "Account" links.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const actor = await requirePlatformAdminOrNull()

  return (
    <div className="min-h-dvh bg-page">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between p-4">
          {/* Not a link when signed out: it would bounce to this same page. */}
          {actor ? (
            <Link href="/platform" className="flex items-center gap-2">
              <Logo size={24} />
              <span className="text-sm font-semibold text-navy-900">Platform</span>
            </Link>
          ) : (
            <span className="flex items-center gap-2">
              <Logo size={24} />
              <span className="text-sm font-semibold text-navy-900">Platform</span>
            </span>
          )}

          {actor ? (
            <nav className="flex items-center gap-4">
              <Link href="/platform/audit" className="text-sm font-semibold text-muted underline">
                Activity
              </Link>
              <Link href="/platform/account" className="text-sm font-semibold text-muted underline">
                Account
              </Link>
            </nav>
          ) : null}
        </div>
      </header>
      {children}
    </div>
  )
}
