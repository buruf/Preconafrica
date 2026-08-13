import { requireStaff } from '@/server/session'
import { AppShell } from '@/components/AppShell'

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  // Still the guard, still here. The middleware protects nothing (see
  // src/middleware.ts) — this call is the access boundary for every staff page,
  // and it also throws AuthorizationError for a signed-in BUYER, which is what
  // keeps a buyer out of /arrears.
  const actor = await requireStaff()

  // The nav, the sign-out control and the password link that used to be
  // hand-written here now come from the shared shell and the profile page:
  // one destination list, two presentations, and no chance of the staff header
  // drifting from the buyer one again.
  return <AppShell role={actor.role}>{children}</AppShell>
}
