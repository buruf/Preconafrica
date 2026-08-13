import { requireUser } from '@/server/session'
import { BuyerHome } from './BuyerHome'
import { StaffHome } from './StaffHome'

/**
 * `/` used to be a redirect — role in, `/projects` or `/dashboard` out. It is a
 * real screen now, and still role-aware: a developer lands on their inventory
 * and their arrears count, a buyer lands on their unit and their balance.
 *
 * The branch is a component choice rather than a redirect so the URL a buyer
 * bookmarks, shares or is emailed is the same `/` a member of staff uses, and
 * the Home tab means "home" for everyone.
 *
 * Each branch re-asserts its own role (`requireStaff` / `requireBuyer`) rather
 * than trusting this read — the guards are the access boundary in this app, and
 * a page that picks a component off a role is not one.
 */
export default async function HomePage() {
  const actor = await requireUser()

  return actor.role === 'BUYER' ? <BuyerHome /> : <StaffHome />
}
