import Link from 'next/link'
import { requireBuyer } from '@/server/session'
import { signOut } from '@/server/auth'

export default async function BuyerLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireBuyer()

  return (
    <div className="min-h-dvh">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 p-3">
          <nav className="flex gap-3 text-sm font-medium">
            <Link href="/dashboard">Dashboard</Link>
          </nav>
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/login' })
            }}
          >
            <button className="text-sm text-slate-500">
              {actor.fullName.split(' ')[0]} · Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">{children}</main>
    </div>
  )
}
