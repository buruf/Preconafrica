import { requireAdmin } from '@/server/session'
import { getOrganization, listTeam } from '@/server/services/team'
import { Card, PageHeader } from '@/components/ui'
import { AddAgentForm } from './AddAgentForm'
import { DeactivateControl } from './DeactivateControl'
import { OrganizationForm } from './OrganizationForm'

const ROLE_TONE: Record<'ADMIN' | 'AGENT', string> = {
  ADMIN: 'bg-slate-100 text-slate-700',
  AGENT: 'bg-sky-100 text-sky-800'
}

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
                      <p className="font-medium">{member.fullName}</p>
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_TONE[member.role]}`}
                      >
                        {member.role}
                      </span>
                      {!member.active ? (
                        <span className="inline-block rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800">
                          Deactivated
                        </span>
                      ) : null}
                      {member.id === actor.userId ? (
                        <span className="text-xs text-slate-500">(you)</span>
                      ) : null}
                    </div>
                    <p className="text-sm text-slate-500">{member.email}</p>
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
