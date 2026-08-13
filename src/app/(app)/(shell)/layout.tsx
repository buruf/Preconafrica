import { requireUser } from '@/server/session'
import { AppShell } from '@/components/AppShell'

/**
 * The shell for the two screens both roles share: home (`/`) and profile.
 *
 * A third route group rather than a copy of either existing one, because `/`
 * and `/profile` resolve to a single path each — two groups cannot both serve
 * them — and because the guard here is genuinely different: `requireUser`
 * authenticates without demanding a role, which is exactly what a role-aware
 * home screen needs. The staff and buyer groups keep their own stricter guards.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireUser()

  return <AppShell role={actor.role}>{children}</AppShell>
}
