'use server'

import { redirect } from 'next/navigation'
import { auth, signIn } from '@/server/auth'
import { requireUser } from '@/server/session'
import { prisma } from '@/server/db'
import { ServiceError } from '@/server/services/errors'
import {
  BuyerRegistrationSchema,
  PlanSelectionSchema,
  createSale,
  registerBuyer
} from '@/server/services/sales'
import { issueStatement } from '@/server/documents/issue'

// A "use server" file may only export async functions, so the maxDuration
// route-segment config for createSaleAction's write path lives on the page
// that invokes it (confirm/page.tsx) instead of here.

export async function registerAndSelectAction(
  projectId: string,
  _prev: string | undefined,
  formData: FormData
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { orgId: true }
  })
  if (!project) return 'That project could not be found.'

  const raw = Object.fromEntries(formData)

  const plan = PlanSelectionSchema.safeParse(raw)
  if (!plan.success) return plan.error.issues[0]?.message ?? 'Please choose a unit and a plan.'

  // A visitor who is already signed in as a buyer does not see the
  // registration fields on the page, so this form only carries unit/plan
  // data for them — skip registration and reuse their existing session.
  const session = await auth()
  const alreadySignedInAsBuyer = session?.user?.role === 'BUYER'

  if (!alreadySignedInAsBuyer) {
    const parsed = BuyerRegistrationSchema.safeParse(raw)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Please check your details.'

    try {
      await registerBuyer(project.orgId, parsed.data)
    } catch (error) {
      return error instanceof ServiceError ? error.message : 'Could not create your account.'
    }

    // With redirect:false, next-auth v5 resolves to the URL it would have
    // redirected to — a callback URL on success, or the sign-in page with an
    // `error=` query param on failure. It never throws for bad credentials.
    const result: unknown = await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false
    })
    if (typeof result === 'string' && result.includes('error=')) {
      // Should not happen right after a successful registration (the same
      // password was just hashed and stored), but a silent failure here
      // would strand the buyer on a confirm page they have no session for.
      return 'Your account was created, but signing you in failed. Please sign in and try again.'
    }
  }

  const query = new URLSearchParams({
    unitId: plan.data.unitId,
    planType: plan.data.planType,
    deposit: plan.data.deposit,
    termMonths: String(plan.data.termMonths)
  })
  redirect(`/buy/${projectId}/confirm?${query.toString()}`)
}

export async function createSaleAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireUser()
  const plan = PlanSelectionSchema.safeParse(Object.fromEntries(formData))
  if (!plan.success) return plan.error.issues[0]?.message ?? 'Please choose a unit and a plan.'

  // For a BUYER actor, the buyer is always themselves, never a value from the
  // form — this is what stops a buyer from ever purchasing on someone else's
  // behalf. Staff actors (ADMIN/AGENT) pass a buyerId form field instead;
  // that path is unused by this page today but is exercised by staff-facing
  // sale flows.
  const buyerId = actor.role === 'BUYER' ? actor.buyerId : String(formData.get('buyerId') ?? '')
  if (!buyerId) return 'No buyer is associated with this purchase.'

  let saleId: string
  try {
    const result = await createSale(actor, {
      buyerId,
      unitId: plan.data.unitId,
      planType: plan.data.planType,
      deposit: plan.data.deposit,
      termMonths: plan.data.termMonths,
      signedAt: new Date()
    })
    saleId = result.saleId
  } catch (error) {
    // The likely failure here is losing the race for the unit — say so plainly.
    return error instanceof ServiceError ? error.message : 'Could not complete the purchase.'
  }

  try {
    // A statement of the full schedule at signing, per the spec. Its failure
    // must not lose the sale that already committed above.
    await issueStatement(actor, saleId)
  } catch (error) {
    console.error(`issueStatement failed for sale ${saleId}`, error)
  }

  redirect(actor.role === 'BUYER' ? '/dashboard' : `/sales/${saleId}`)
}
