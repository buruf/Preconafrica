import { requireUser, type Role } from '@/server/session'
import { getOrganizationName } from '@/server/services/team'
import { signOut } from '@/server/auth'
import { Button, ButtonLink, Card, PageHeader } from '@/components/ui'

/**
 * Who you are, which organisation you are in, and the two things you can do
 * about it.
 *
 * This is where sign-out moved to. It used to sit in the top-right of every
 * page's header, which cost a permanent 44px of chrome on a 360px screen to
 * host a control most people press once a week — and which put "Sign out" a
 * thumb-slip away from the nav on every single screen.
 *
 * It is also where Team lives for an admin, rather than being a fifth tab. See
 * src/components/nav.ts for why: the bar is four destinations for every role,
 * and a link on a page is reachable identically from both presentations.
 */

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrator',
  AGENT: 'Sales agent',
  BUYER: 'Buyer'
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="min-w-0 break-words text-right text-[15px] font-medium text-ink">
        {value}
      </span>
    </div>
  )
}

export default async function ProfilePage() {
  const actor = await requireUser()
  const organizationName = await getOrganizationName(actor)

  // The two copies of the change-password screen live under each role's own
  // shell, so the link has to know which one it is sending you to. Both are
  // guarded by their own layout; neither is reachable by the other role.
  const passwordHref =
    actor.role === 'BUYER' ? '/dashboard/account/password' : '/account/password'

  return (
    <>
      <PageHeader title="Profile" />

      <Card className="mb-4">
        <div className="divide-y divide-line">
          <Row label="Name" value={actor.fullName} />
          <Row label="Email" value={actor.email} />
          <Row label="Role" value={ROLE_LABEL[actor.role]} />
          <Row label="Organisation" value={organizationName} />
        </div>
      </Card>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <ButtonLink href={passwordHref} variant="secondary" className="w-full sm:w-auto">
          Change password
        </ButtonLink>

        {actor.role === 'ADMIN' ? (
          <>
            <ButtonLink href="/team" variant="secondary" className="w-full sm:w-auto">
              Team &amp; organisation
            </ButtonLink>
            {/* Beside Team, and here for the same reason Team is: it is
                occasional org administration, and an admin-only fifth tab would
                make an admin's nav a different shape from an agent's on the
                same screens. See src/components/nav.ts. */}
            <ButtonLink href="/audit" variant="secondary" className="w-full sm:w-auto">
              Audit log
            </ButtonLink>
          </>
        ) : null}
      </div>

      <form
        action={async () => {
          'use server'
          await signOut({ redirectTo: '/login' })
        }}
      >
        <Button type="submit" variant="danger" className="w-full sm:w-auto">
          Sign out
        </Button>
      </form>
    </>
  )
}
