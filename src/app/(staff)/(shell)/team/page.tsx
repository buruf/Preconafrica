import { requireAdmin } from '@/server/session'
import { getOrganization, listTeam } from '@/server/services/team'
import { Card, PageHeader, StatusPill } from '@/components/ui'
import { AddAgentForm } from './AddAgentForm'
import { DeactivateControl } from './DeactivateControl'
import { OrganizationForm } from './OrganizationForm'

/**
 * A role is not a status, so it does not borrow the status triples — an ADMIN is
 * not "paid" and an AGENT is not "reserved", and colouring them from that table
 * would teach the reader a meaning that is not there. Both roles get the same
 * quiet navy tint from DESIGN.md, and the word does the distinguishing.
 *
 * Deactivation *is* a status, so it gets the overdue pill through `StatusPill`
 * below, which is also the app's only red badge.
 */
const ROLE_TONE = 'bg-navy-100 text-navy-900'

export default async function TeamPage() {
  // ADMIN-only: an agent has no business seeing the team list, so this
  // throws AuthorizationError straight into the (staff) error boundary
  // rather than redirecting somewhere friendlier.
  const actor = await requireAdmin()
  // Independent reads, both ADMIN-scoped — issued together rather than in
  // sequence so the page costs one round trip's latency, not two.
  const [members, org] = await Promise.all([listTeam(actor), getOrganization(actor)])

  return (
    <>
      <PageHeader title="Team" subtitle="Manage who at your organisation can sign in as staff." />

      <div className="space-y-6">
        <OrganizationForm orgName={org.name} logoUrl={org.logoUrl} />

        <AddAgentForm />

        <ul className="space-y-3">
          {members.map((member) => (
            <li key={member.id}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[15px] font-semibold text-navy-900">{member.fullName}</p>
                      <span
                        className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${ROLE_TONE}`}
                      >
                        {member.role}
                      </span>
                      {!member.active ? (
                        <StatusPill status="OVERDUE">Deactivated</StatusPill>
                      ) : null}
                      {member.id === actor.userId ? (
                        <span className="text-[13px] text-muted">(you)</span>
                      ) : null}
                    </div>
                    <p className="text-[13px] text-muted">{member.email}</p>
                  </div>

                  {/* Only active AGENT rows get a deactivate control: an
                      admin cannot deactivate themselves or another admin
                      (the service only ever looks up role: 'AGENT'), and an
                      already-deactivated agent has nothing left to do here. */}
                  {member.role === 'AGENT' && member.active ? (
                    <DeactivateControl userId={member.id} />
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
