import { PageHeader } from '@/components/ui'
import { ChangePasswordForm } from '@/components/ChangePasswordForm'
import { requireUser } from '@/server/session'

/**
 * `/dashboard/account/password`, not `/account/password`, and not by
 * preference: `(staff)` and `(buyer)` are route *groups*, so they contribute
 * nothing to the URL, and a page at `account/password` in both resolves to one
 * path twice — which Next refuses to build ("You cannot have two parallel
 * pages that resolve to the same path"). The buyer copy therefore hangs off
 * the segment the buyer shell already owns. The alternative, one shared page
 * outside both groups, would have cost this page its shell chrome and left
 * buyers on a screen with no navigation back.
 */
export default async function BuyerPasswordPage() {
  // requireUser, not requireBuyer: this page is about the account, not about
  // anything buyer-only. The shell above it has already established the role,
  // but a page still calls its own guard — that is the rule here, and it is
  // what makes a forgotten layout a non-event.
  await requireUser()

  return (
    <>
      <PageHeader title="Password" subtitle="Change the password you sign in with." />
      <div className="max-w-md">
        <ChangePasswordForm />
      </div>
    </>
  )
}
