'use server'

import { redirect } from 'next/navigation'
import { buyerRegistrationScopes } from '@/domain/rate-limit'
import {
  RATE_LIMIT_MESSAGE,
  checkRateLimit,
  clientIp,
  recordRateLimitHit
} from '@/server/rate-limit'
import { requireStaff } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import {
  BuyerRegistrationSchema,
  FeeOverrideSchema,
  PlanSelectionSchema,
  createSale,
  registerBuyer
} from '@/server/services/sales'
import { prisma } from '@/server/db'
import { issueStatement } from '@/server/documents/issue'
import { percentToBps, type InstallmentFeeConfig } from '@/domain/schedule'
import { toMinor } from '@/domain/currency'

// A "use server" file may only export async functions, so the maxDuration
// route-segment config for createStaffSaleAction's write path lives on the
// page that invokes it (confirm/page.tsx), not here.

/**
 * The fee half of the sell form — a mode and whichever field that mode uses —
 * to an optional override.
 *
 * Blank means "use the project default", which is why this returns undefined
 * rather than a zero charge: those are different instructions, and conflating
 * them would make an agent who left the field alone silently waive the fee.
 *
 * The flat amount is parsed with `toMinor` against the project's own currency,
 * never a generic number parse — "2500000" is 2,500,000.00 in NGN and
 * 2,500,000 in RWF, and only the currency knows which. Throws on a bad value;
 * the caller turns that into a message on the form.
 */
function parseFeeOverride(
  formData: FormData,
  currency: string
): InstallmentFeeConfig | undefined {
  if (String(formData.get('feeMode') ?? 'PERCENT') === 'FIXED') {
    const raw = String(formData.get('fixedFee') ?? '').trim()
    if (raw === '') return undefined
    return { mode: 'FIXED', bps: 0, fixedMinor: toMinor(raw, currency) }
  }

  const raw = String(formData.get('markupPercent') ?? '').trim()
  if (raw === '') return undefined
  return { mode: 'PERCENT', bps: percentToBps(raw), fixedMinor: 0n }
}

/**
 * Step 1 of the staff sale: validate the whole form, make sure a buyer exists,
 * and hand the choices to the confirm page. Nothing about the sale is written
 * here — the unit is not claimed and no schedule is generated.
 *
 * A new buyer, though, *is* written before the redirect. The alternative is
 * carrying their password through a URL, which is not an alternative at all.
 * The cost is an account with no sale if the agent abandons the confirm step;
 * that buyer is simply available in the "existing buyer" picker next time,
 * which is the same state a registration that raced a taken unit would leave.
 */
export async function previewSaleAction(
  projectId: string,
  unitId: string,
  _prev: string | undefined,
  formData: FormData
) {
  const actor = await requireStaff()

  const plan = PlanSelectionSchema.safeParse({
    ...Object.fromEntries(formData),
    // From the route, never the form: the unit being sold is the page you are
    // on, and accepting it as a field would let a stale tab sell a different
    // one than the header says.
    unitId
  })
  if (!plan.success) {
    return plan.error.issues[0]?.message ?? 'Please check the payment plan.'
  }

  // The currency comes from the project, scoped to the actor's org — a flat fee
  // cannot be parsed without knowing how many minor units its currency has, and
  // that answer must never come from the browser.
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId: actor.orgId },
    select: { currency: true }
  })
  if (!project) return 'That project could not be found.'

  let fee: InstallmentFeeConfig | undefined
  try {
    fee = parseFeeOverride(formData, project.currency)
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid installment charge.'
  }

  let buyerId: string
  if (formData.get('buyerMode') === 'existing') {
    buyerId = String(formData.get('buyerId') ?? '')
    if (!buyerId) return 'Choose a buyer, or register a new one.'

    // Org-scoped: an id typed into a stale form must not reach createSale as a
    // buyer from another developer's roster. createSale scopes it again — this
    // check exists so the agent gets a form message instead of a thrown error
    // on the next page.
    const buyer = await prisma.buyer.findFirst({
      where: { id: buyerId, orgId: actor.orgId },
      select: { id: true }
    })
    if (!buyer) return 'That buyer could not be found.'
  } else {
    const parsed = BuyerRegistrationSchema.safeParse(Object.fromEntries(formData))
    if (!parsed.success) {
      return parsed.error.issues[0]?.message ?? 'Please check the buyer details.'
    }

    /**
     * This branch creates a User row, so it is throttled like every other
     * account-creating surface — but keyed on the acting staff member rather
     * than on anything the form supplied. It sits behind `requireStaff`, so
     * this is not an anonymous attack surface; it is a bound on how fast a
     * stolen or scripted staff session can fill the user table, set generously
     * enough (10 a minute, 60 an hour) that an agent registering walk-ins all
     * morning never meets it.
     *
     * Checked and counted after validation, so a mistyped phone number does
     * not spend an agent's budget on a form that was never going to write
     * anything.
     */
    const registrationScopes = buyerRegistrationScopes(actor.userId, clientIp())
    const gate = await checkRateLimit(registrationScopes, new Date())
    if (!gate.allowed) return RATE_LIMIT_MESSAGE
    await recordRateLimitHit(registrationScopes, new Date())

    try {
      const registered = await registerBuyer(actor.orgId, parsed.data)
      buyerId = registered.buyerId
    } catch (error) {
      // The likely failure is a duplicate email — an agent registering someone
      // who already has an account. The service says so; pass it through so the
      // agent knows to switch to the existing-buyer picker.
      return error instanceof ServiceError ? error.message : 'Could not register that buyer.'
    }
  }

  const query = new URLSearchParams({
    buyerId,
    planType: plan.data.planType,
    deposit: plan.data.deposit,
    termMonths: String(plan.data.termMonths)
  })
  // Only when the agent actually overrode it. An absent param is what tells the
  // confirm page to quote the project default, and it must stay absent rather
  // than become a 0 that reads as "this sale is free of charge". The amount
  // travels as minor units, already parsed against the project's currency, so
  // no decimal is re-interpreted on the far side.
  if (fee !== undefined) {
    query.set('feeMode', fee.mode)
    if (fee.mode === 'FIXED') query.set('fixedFeeMinor', fee.fixedMinor.toString())
    else query.set('markupBps', String(fee.bps))
  }

  redirect(`/projects/${projectId}/sell/${unitId}/confirm?${query.toString()}`)
}

/** Step 2: the only write. Claims the unit, signs the contract, issues the statement. */
export async function createStaffSaleAction(
  unitId: string,
  _prev: string | undefined,
  formData: FormData
) {
  const actor = await requireStaff()

  const plan = PlanSelectionSchema.safeParse(Object.fromEntries(formData))
  if (!plan.success) return plan.error.issues[0]?.message ?? 'Please check the payment plan.'

  // The unit is bound from the route (same as previewSaleAction), not the form:
  // the confirm page quoted terms for THIS unit, so an edited hidden field must
  // not be able to sign those terms against a different one.
  if (plan.data.unitId !== unitId) return 'This confirmation is for a different unit.'

  // Mode and value together, exactly as the confirm page priced them. Parsed
  // rather than trusted: these are hidden fields, so a tampered pair must fail
  // here rather than reach the ledger.
  const fee = FeeOverrideSchema.safeParse({
    feeMode: formData.get('feeMode'),
    markupBps: formData.get('markupBps'),
    fixedFeeMinor: formData.get('fixedFeeMinor')
  })
  if (!fee.success) {
    return fee.error.issues[0]?.message ?? 'Invalid installment charge.'
  }

  // Taken from the form rather than the session, because staff sell on behalf
  // of a buyer — that is the whole pivot. It is safe to trust this far: createSale
  // scopes the buyer to the actor's organisation and refuses anything else.
  const buyerId = String(formData.get('buyerId') ?? '')
  if (!buyerId) return 'No buyer is associated with this sale.'

  let saleId: string
  try {
    const result = await createSale(actor, {
      buyerId,
      unitId,
      planType: plan.data.planType,
      deposit: plan.data.deposit,
      termMonths: plan.data.termMonths,
      fee: fee.data,
      signedAt: new Date()
    })
    saleId = result.saleId
  } catch (error) {
    // Most likely: another agent claimed the unit between the two steps.
    return error instanceof ServiceError ? error.message : 'Could not complete the sale.'
  }

  try {
    // A statement of the full schedule at signing, per the spec. Its failure
    // must not lose the sale that already committed above.
    await issueStatement(actor, saleId)
  } catch (error) {
    console.error(`issueStatement failed for sale ${saleId}`, error)
  }

  redirect(`/sales/${saleId}`)
}
