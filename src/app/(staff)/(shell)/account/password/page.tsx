import { PageHeader } from '@/components/ui'
import { ChangePasswordForm } from '@/components/ChangePasswordForm'
import { requireUser } from '@/server/session'

export default async function StaffPasswordPage() {
  // requireUser, not requireStaff: this page is about the account, not about
  // anything staff-only, and the shell above it has already established the
  // role. Every page calls its own guard regardless — the shell's is not a
  // substitute for this one.
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
