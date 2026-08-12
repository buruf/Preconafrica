import Link from 'next/link'
import { requireBuyer } from '@/server/session'
import { signOut } from '@/server/auth'

export default async function BuyerLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireBuyer()

  return (
    <div className="min-h-dvh">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-1 px-3">
          {/* min-h-11 keeps every control in the header at the 44px tap-target
              floor — this chrome is inherited by every buyer page. */}
          <nav className="flex text-sm font-medium">
            <Link href="/dashboard" className="flex min-h-11 items-center px-2">
              Dashboard
            </Link>
            <Link href="/dashboard/account/password" className="flex min-h-11 items-center px-2">
              Password
            </Link>
          </nav>
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/login' })
            }}
          >
            <button className="flex min-h-11 items-center px-2 text-sm text-slate-500">
              {actor.fullName.split(' ')[0]} · Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">{children}</main>
    </div>
  )
}
