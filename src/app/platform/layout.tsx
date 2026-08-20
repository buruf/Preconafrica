import Link from 'next/link'
import { Logo } from '@/components/Logo'

/**
 * The console's own chrome: a plain header and nothing else.
 *
 * Deliberately not the app's shell. There is no bottom tab bar and no
 * Projects/Arrears/Profile — those belong to a developer working inside one
 * organisation, and every one of them would 404 or redirect for an operator
 * who has none. Sharing the shell would also blur the line this whole feature
 * exists to draw.
 */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-page">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between p-4">
          <Link href="/platform" className="flex items-center gap-2">
            <Logo size={24} />
            <span className="text-sm font-semibold text-navy-900">Platform</span>
          </Link>
          <Link href="/platform/audit" className="text-sm font-semibold text-muted underline">
            Activity
          </Link>
        </div>
      </header>
      {children}
    </div>
  )
}
