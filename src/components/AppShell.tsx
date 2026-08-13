import type { ReactNode } from 'react'
import { AppNav } from '@/components/AppNav'
import { destinationsFor } from '@/components/nav'
import type { Role } from '@/server/session'

/**
 * The chrome every signed-in screen sits inside: brand bar, destinations, and a
 * main column that never lets the fixed bottom bar cover its last row.
 *
 * A server component. It resolves the destinations for the role and hands them
 * to `AppNav` as data; the only reason any of this is a client component is the
 * current path.
 *
 * Deliberately not a route layout of its own. Each role's layout still calls its
 * own guard — `requireStaff` / `requireBuyer` / `requireUser` — and then renders
 * this. The middleware is inert by design (see src/middleware.ts), so those
 * guards are the entire access boundary and moving them into shared chrome
 * would be the one refactor that could quietly remove them.
 */
export function AppShell({ role, children }: { role: Role; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-page">
      <AppNav destinations={destinationsFor(role)} />

      {/*
        The bottom padding is the bar (3.5rem) plus the safe-area inset plus a
        1.5rem breath, so the last row of a list is scrollable clear of the bar
        rather than half-hidden behind it. From `sm:` the bar is gone and the
        padding is ordinary.
      */}
      <main className="mx-auto max-w-5xl px-4 pb-[calc(3.5rem+env(safe-area-inset-bottom)+1.5rem)] pt-4 sm:px-6 sm:pb-10 sm:pt-6">
        {children}
      </main>
    </div>
  )
}
