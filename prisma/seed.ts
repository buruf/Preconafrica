import { PrismaClient, type PaymentMethod, type PlanType } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { formatMinor, toMinor } from '../src/domain/currency'
import { allocatePayment } from '../src/domain/allocation'
import {
  NO_INSTALLMENT_FEE,
  computeInstallmentFeeMinor,
  generateSchedule,
  installmentFeeSummary,
  isFreeInstallmentFee,
  type InstallmentFeeMode
} from '../src/domain/schedule'
import { generateUnitNames } from '../src/domain/units'
import { applyAllocations } from '../src/server/services/allocations'
import { formatDocumentNumber, nextDocumentSequence } from '../src/server/documents/numbering'
import { assertSeedTargetIsSafe } from './seed-guard'

const prisma = new PrismaClient()
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

/**
 * The project's charge in the shape the domain wants it.
 *
 * Duplicated from `services/sales.ts` rather than imported, for the same reason
 * the receipt below is written from the numbering primitives instead of
 * `documents/issue.ts`: sales.ts pulls `@/server/session` and therefore the
 * whole auth stack, which a bare tsx process cannot boot. It is three field
 * reads, and the schedule invariant printed at the end of this file would catch
 * any drift between the two immediately.
 */
function projectFeeConfig(project: {
  installmentFeeMode: InstallmentFeeMode
  installmentMarkupBps: number
  installmentFixedFeeMinor: bigint
}) {
  return {
    mode: project.installmentFeeMode,
    bps: project.installmentMarkupBps,
    fixedMinor: project.installmentFixedFeeMinor
  }
}

/** The charge a signed sale carries, out of its own snapshot. See above. */
function saleFeeConfig(sale: {
  feeMode: InstallmentFeeMode
  markupBps: number
  fixedFeeMinor: bigint
}) {
  return { mode: sale.feeMode, bps: sale.markupBps, fixedMinor: sale.fixedFeeMinor }
}

async function main() {
  // Before the client connects, let alone deletes anything: this throws unless
  // DATABASE_URL demonstrably points somewhere other than the protected branch.
  assertSeedTargetIsSafe()

  // Order matters: children before parents.
  await prisma.notificationLog.deleteMany()
  await prisma.document.deleteMany()
  await prisma.paymentAllocation.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.scheduleEntry.deleteMany()
  await prisma.sale.deleteMany()
  await prisma.unit.deleteMany()
  await prisma.buyer.deleteMany()
  await prisma.project.deleteMany()
  await prisma.user.deleteMany()
  await prisma.organization.deleteMany()

  const passwordHash = await bcrypt.hash('password123', 10)

  const org = await prisma.organization.create({
    data: { name: 'Sunrise Developments', slug: 'sunrise' }
  })

  const admin = await prisma.user.create({
    data: {
      orgId: org.id,
      email: 'admin@sunrise.test',
      passwordHash,
      fullName: 'Adaeze Okonkwo',
      role: 'ADMIN'
    }
  })

  const agent = await prisma.user.create({
    data: {
      orgId: org.id,
      email: 'agent@sunrise.test',
      passwordHash,
      fullName: 'Tunde Bakare',
      role: 'AGENT'
    }
  })

  // Two currencies, deliberately: one two-decimal (NGN) and one that is also
  // two-decimal but a different market (KES), proving nothing is USD-bound.
  const lagos = await prisma.project.create({
    data: {
      orgId: org.id,
      name: 'Sunrise Heights',
      location: 'Lekki Phase 1, Lagos, Nigeria',
      currency: 'NGN',
      expectedCompletion: utc(2028, 6, 30),
      floors: 4,
      unitsPerFloor: 6,
      startFloor: 1,
      namingPattern: '{floor}{index:02}',
      // The FIXED demonstration, explicit rather than left to the column
      // default. ₦2,500,000 flat: the same charge whether a buyer finances 60
      // million or 6, which is the whole point of the mode — a percentage of
      // the financed amount is interest, and interest is not permissible in
      // every market this platform serves.
      //
      // One project on FIXED and one on PERCENT means every schedule, dashboard
      // line, confirm page and PDF is exercised in both configurations from the
      // first page load, rather than only in the familiar one.
      installmentFeeMode: 'FIXED',
      installmentMarkupBps: 0,
      installmentFixedFeeMinor: toMinor('2500000', 'NGN'),
      reminderDaysBefore: 7,
      overdueNoticeDaysAfter: 3
    }
  })

  const nairobi = await prisma.project.create({
    data: {
      orgId: org.id,
      name: 'Riverside Court',
      location: 'Westlands, Nairobi, Kenya',
      currency: 'KES',
      expectedCompletion: utc(2027, 12, 31),
      floors: 4,
      unitsPerFloor: 6,
      startFloor: 1,
      namingPattern: '{floor}{letter}',
      // The PERCENT demonstration, unchanged: 10% on whatever a buyer finances.
      // Both Nairobi installment plans below carry it, so the "includes an
      // installment charge (10%)" line on the dashboards and the rate quoted on
      // the statement have real figures behind them from the first page load.
      installmentFeeMode: 'PERCENT',
      installmentMarkupBps: 1000,
      installmentFixedFeeMinor: 0n,
      reminderDaysBefore: 10,
      overdueNoticeDaysAfter: 5
    }
  })

  async function createUnits(
    project: { id: string; floors: number; unitsPerFloor: number; namingPattern: string; startFloor: number },
    currency: string,
    priceByBedrooms: Record<number, string>
  ) {
    const drafts = generateUnitNames({
      floors: project.floors,
      unitsPerFloor: project.unitsPerFloor,
      pattern: project.namingPattern,
      startFloor: project.startFloor
    })

    await prisma.unit.createMany({
      data: drafts.map((draft) => {
        // Cycle of 3: indexOnFloor 1 -> 2 bedrooms, 2 -> 3 bedrooms, 3 -> 1
        // bedroom, then repeats (4 -> 2, 5 -> 3, 6 -> 1, ...). This is the
        // single source of truth for which unit name gets which bedroom
        // count and therefore which price — get a unit name's bedroom count
        // wrong here and every hand-picked payment amount for it stops
        // lining up with the generated schedule.
        const bedrooms = (draft.indexOnFloor % 3) + 1
        return {
          projectId: project.id,
          name: draft.name,
          floor: draft.floor,
          bedrooms,
          sizeSqm: bedrooms * 45,
          priceMinor: toMinor(priceByBedrooms[bedrooms], currency)
        }
      })
    })
  }

  await createUnits(lagos, 'NGN', { 1: '85000000', 2: '145000000', 3: '250000000' })
  await createUnits(nairobi, 'KES', { 1: '7500000', 2: '11200000', 3: '18400000' })

  async function createBuyer(
    fullName: string,
    email: string,
    phone: string,
    address: string | null
  ) {
    const user = await prisma.user.create({
      data: { orgId: org.id, email, passwordHash, fullName, role: 'BUYER' }
    })
    return prisma.buyer.create({
      data: { orgId: org.id, userId: user.id, fullName, phone, email, address }
    })
  }

  /**
   * Creates a sale using the real domain functions, then applies payments
   * through the real allocation function and the real `applyAllocations`
   * helper — the same write-then-recompute logic `recordPayment` uses, so the
   * seed can never drift from what the service actually does. It comes from
   * `services/allocations`, which imports nothing but Prisma and pure domain
   * types, so seeding never has to boot the auth stack.
   */
  async function createSale(opts: {
    /**
     * The project row itself, not an id plus a currency. The currency and the
     * installment charge have to be the ones this project actually carries: a
     * seed that passed them separately could name Riverside Court and price it
     * in NGN at 0%, and the mismatch would only surface as figures that quietly
     * fail to add up.
     */
    project: {
      id: string
      currency: string
      installmentFeeMode: InstallmentFeeMode
      installmentMarkupBps: number
      installmentFixedFeeMinor: bigint
    }
    buyerId: string
    buyerName: string
    unitName: string
    planType: PlanType
    depositMajor: string
    termMonths: number | null
    signedAt: Date
    payments: Array<{ amountMajor: string; receivedAt: Date; method: PaymentMethod; reference: string }>
  }) {
    const currency = opts.project.currency
    const unit = await prisma.unit.findFirstOrThrow({
      where: { projectId: opts.project.id, name: opts.unitName }
    })

    const depositMinor = toMinor(opts.depositMajor, currency)
    // The project's default charge — mode and value — snapshotted onto the
    // sale, exactly what `createSale` resolves for a staff-created sale with no
    // override, which is what every seeded sale is. No charge at all for a FULL
    // plan whatever the project asks: nothing is financed, so there is nothing
    // to charge for, and `generateSchedule` rejects a charged full payment
    // outright. This mirrors `resolveInstallmentFee` rather than calling it,
    // because that function needs a SessionActor and the seed has no session.
    const fee =
      opts.planType === 'INSTALLMENTS'
        ? projectFeeConfig(opts.project)
        : NO_INSTALLMENT_FEE
    const drafts = generateSchedule({
      planType: opts.planType,
      priceMinor: unit.priceMinor,
      depositMinor,
      fee,
      months: opts.termMonths ?? 0,
      signedAt: opts.signedAt
    })

    const sale = await prisma.sale.create({
      data: {
        orgId: org.id,
        projectId: opts.project.id,
        unitId: unit.id,
        buyerId: opts.buyerId,
        planType: opts.planType,
        priceMinor: unit.priceMinor,
        depositMinor,
        feeMode: fee.mode,
        markupBps: fee.bps,
        fixedFeeMinor: fee.fixedMinor,
        currency: currency,
        termMonths: opts.termMonths,
        signedAt: opts.signedAt,
        createdByUserId: agent.id,
        scheduleEntries: { create: drafts }
      }
    })

    await prisma.unit.update({ where: { id: unit.id }, data: { status: 'SOLD' } })

    for (const p of opts.payments) {
      const entries = await prisma.scheduleEntry.findMany({
        where: { saleId: sale.id },
        orderBy: { sequence: 'asc' }
      })

      const { allocations, overpaymentMinor } = allocatePayment(
        entries.map((e) => ({
          id: e.id,
          sequence: e.sequence,
          amountDueMinor: e.amountDueMinor,
          amountPaidMinor: e.amountPaidMinor
        })),
        toMinor(p.amountMajor, currency)
      )

      // A seed that quietly loses money is worse than one that fails loudly:
      // if a future buyer state overpays, surface it instead of letting the
      // surplus vanish and Payment.amountMinor drift from its allocations.
      if (overpaymentMinor > 0n) {
        throw new Error(
          `Seed payment ${p.reference} for ${opts.buyerName} (sale on unit ${opts.unitName}) overpays by ${overpaymentMinor} minor units — reduce the amount or extend the schedule.`
        )
      }

      // One transaction per payment: applyAllocations requires a
      // Prisma.TransactionClient (its contract is unconditional — it must
      // run inside a transaction), and createSale otherwise works through
      // the raw `prisma` client. Opening the transaction here, rather than
      // widening the service's signature, keeps that guarantee intact.
      await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({
          data: {
            orgId: org.id,
            saleId: sale.id,
            amountMinor: toMinor(p.amountMajor, currency),
            receivedAt: p.receivedAt,
            method: p.method,
            reference: p.reference,
            recordedByUserId: agent.id
          }
        })

        // `entries` is the schedule the allocation was computed from, so it
        // already carries every amountDueMinor the recompute needs.
        await applyAllocations(tx, payment.id, allocations, p.receivedAt, entries)

        // A receipt per payment, exactly as recordPayment would issue one.
        // documents/issue.ts pulls the auth stack, which a bare tsx process
        // cannot boot, so the seed uses the same auth-free numbering
        // primitives the service does.
        const sequence = await nextDocumentSequence(tx, org.id)
        await tx.document.create({
          data: {
            orgId: org.id,
            saleId: sale.id,
            type: 'RECEIPT',
            number: formatDocumentNumber('RECEIPT', sequence),
            sequence,
            paymentId: payment.id
          }
        })
      })
    }

    // Same rule recordPayment's syncSaleStatus applies once the last
    // installment lands: a sale whose every entry is settled is COMPLETED, not
    // ACTIVE. Read back from the entries after the payment loop rather than
    // inferred from the fixture's intent, so this cannot drift from what the
    // allocations actually did. Without it, Amina's fully paid demo sale read
    // ACTIVE — a state the running app would never produce.
    const settledEntries = await prisma.scheduleEntry.findMany({
      where: { saleId: sale.id },
      select: { amountDueMinor: true, amountPaidMinor: true }
    })
    if (settledEntries.every((entry) => entry.amountPaidMinor >= entry.amountDueMinor)) {
      await prisma.sale.update({ where: { id: sale.id }, data: { status: 'COMPLETED' } })
    }

    // The statement of the full schedule at signing, as the buy flow issues.
    await prisma.$transaction(async (tx) => {
      const sequence = await nextDocumentSequence(tx, org.id)
      await tx.document.create({
        data: {
          orgId: org.id,
          saleId: sale.id,
          type: 'STATEMENT',
          number: formatDocumentNumber('STATEMENT', sequence),
          sequence
        }
      })
    })

    return sale
  }

  const amina = await createBuyer('Amina Yusuf', 'amina@buyer.test', '+2348031234567', '14 Admiralty Way, Lekki, Lagos')
  const kwame = await createBuyer('Kwame Mensah', 'kwame@buyer.test', '+254712345678', 'Riverside Drive, Nairobi')
  const zainab = await createBuyer('Zainab Bello', 'zainab@buyer.test', '+2347098765432', null)
  const joseph = await createBuyer('Joseph Otieno', 'joseph@buyer.test', '+254733222111', 'Ngong Road, Nairobi')

  // Every installment fixture below opens with a payment for the deposit
  // itself, because the deposit is receivable, not received: it is schedule
  // entry 0, due on the signing day, and the only thing that settles it is a
  // Payment allocated against it. A seeded buyer with no deposit payment is a
  // buyer who signed, never paid a naira, and is one day in arrears — which is
  // the truth of the model but not the demo state these four fixtures exist to
  // show. `allocatePayment` walks the entries in sequence order, so the deposit
  // payment lands on entry 0 with no special handling here.

  // 1. Full payment, settled. Nothing financed, so no deposit and no charge.
  // Unit '101' is the deliberate choice: indexOnFloor 1 -> 2 bedrooms ->
  // 145,000,000 NGN, which is exactly the payment amount below. Unit '102'
  // (3 bedrooms, 250,000,000 NGN) would leave this "settled" sale half paid.
  await createSale({
    project: lagos, buyerId: amina.id, buyerName: amina.fullName, unitName: '101',
    planType: 'FULL', depositMajor: '0', termMonths: null, signedAt: utc(2026, 3, 2),
    payments: [{ amountMajor: '145000000', receivedAt: utc(2026, 3, 2), method: 'BANK_TRANSFER', reference: 'GTB/2026/03/0021' }]
  })

  // 2. 36-month plan, fully current — deposit plus five installments paid on time.
  // Unit '2A' (2 bedrooms, 11,200,000 KES). A 2,000,000 deposit finances
  // 9,200,000; Riverside Court charges 10%, so the markup is 920,000 and the
  // installments amortize 10,120,000 -> 281,111.11 a month (x35, final
  // 281,111.15). Total owed is 12,120,000 = price 11,200,000 + markup 920,000.
  // The deposit payment settles entry 0 exactly; each of the five monthly
  // payments settles one installment exactly, so nothing is left partial.
  // Installments 1-5 fell due Mar-Jul 2026 and are paid; installment 6 is not
  // due until 2026-08-15, so this buyer has nothing overdue.
  await createSale({
    project: nairobi, buyerId: kwame.id, buyerName: kwame.fullName, unitName: '2A',
    planType: 'INSTALLMENTS', depositMajor: '2000000', termMonths: 36, signedAt: utc(2026, 2, 15),
    payments: [
      { amountMajor: '2000000', receivedAt: utc(2026, 2, 15), method: 'BANK_TRANSFER', reference: 'KCB/2026/02/1188' },
      ...[1, 2, 3, 4, 5].map((m) => ({
        amountMajor: '281111.11', receivedAt: utc(2026, 2 + m, 15), method: 'MOBILE_MONEY' as PaymentMethod,
        reference: `MPESA-RJ${m}K4T2X9`
      }))
    ]
  })

  // 3. Partial payment outstanding on the current installment — and the FIXED
  // fixture. Unit '303' (1 bedroom, 85,000,000 NGN) on Sunrise Heights, which
  // charges a flat 2,500,000: a 25,000,000 deposit finances 60,000,000, the
  // charge is 2,500,000 whatever that figure had been, and the installments
  // amortize 62,500,000 over 36 months -> 1,736,111.11 a month (x35, final
  // 1,736,111.15). Total owed is 87,500,000 = price 85,000,000 + fee 2,500,000.
  //
  // The deposit payment settles entry 0, the second settles installment 1
  // exactly, and the 800,000 lands partway into installment 2 (due 2026-07-20,
  // now past) — one overdue entry. Note the second payment tracks the monthly
  // figure: it was 1,666,666.66 while this project charged nothing, and leaving
  // it there would have left installment 1 short by the fee's share and quietly
  // changed what this fixture demonstrates.
  await createSale({
    project: lagos, buyerId: zainab.id, buyerName: zainab.fullName, unitName: '303',
    planType: 'INSTALLMENTS', depositMajor: '25000000', termMonths: 36, signedAt: utc(2026, 5, 20),
    payments: [
      { amountMajor: '25000000', receivedAt: utc(2026, 5, 20), method: 'BANK_TRANSFER', reference: 'ZEN/2026/05/7742' },
      { amountMajor: '1736111.11', receivedAt: utc(2026, 6, 20), method: 'BANK_TRANSFER', reference: 'ZEN/2026/06/8841' },
      { amountMajor: '800000', receivedAt: utc(2026, 7, 22), method: 'BANK_TRANSFER', reference: 'ZEN/2026/07/9002' }
    ]
  })

  // 4. Several months in arrears, so the arrears report has content on day one.
  // Unit '4C' (indexOnFloor 3 -> 1 bedroom, 7,500,000 KES). A 1,500,000 deposit
  // finances 6,000,000; at Riverside Court's 10% the markup is 600,000, so the
  // installments amortize 6,600,000 -> 183,333.33 a month (x35, final
  // 183,333.45). Total owed is 8,100,000 = price 7,500,000 + markup 600,000.
  //
  // Signed 2026-01-10, so against "today" (2026-08-10) entries 0 through 7 have
  // all reached their due date — but an entry due *today* is not yet overdue
  // (deriveStatus needs the day to have passed), which leaves entries 0-6 as the
  // seven that could be in arrears. The deposit payment settles entry 0. Two
  // CASH payments of 150,000 (300,000 together) then settle installment 1
  // exactly (183,333.33) and land the remaining 116,666.67 into installment 2,
  // leaving it partial. Unsettled and past due: installments 2 (partial), 3, 4,
  // 5 and 6 — exactly five, with installment 7 due today still PENDING.
  await createSale({
    project: nairobi, buyerId: joseph.id, buyerName: joseph.fullName, unitName: '4C',
    planType: 'INSTALLMENTS', depositMajor: '1500000', termMonths: 36, signedAt: utc(2026, 1, 10),
    payments: [
      { amountMajor: '1500000', receivedAt: utc(2026, 1, 10), method: 'BANK_TRANSFER', reference: 'EQTY/2026/01/0417' },
      { amountMajor: '150000', receivedAt: utc(2026, 2, 10), method: 'CASH', reference: 'RCPT-0091' },
      { amountMajor: '150000', receivedAt: utc(2026, 3, 12), method: 'CASH', reference: 'RCPT-0114' }
    ]
  })

  // Per sale, the invariant every other money figure in the platform rests on:
  // the schedule sums to exactly the price plus the charge, in either fee mode.
  // Printed rather than merely asserted so a reseed is its own evidence.
  const seededSales = await prisma.sale.findMany({
    include: {
      unit: { select: { name: true } },
      buyer: { select: { fullName: true } },
      project: { select: { name: true } },
      scheduleEntries: { select: { amountDueMinor: true } }
    },
    orderBy: { signedAt: 'asc' }
  })

  console.log('\nFee mode / schedule invariant, per sale:')
  for (const sale of seededSales) {
    const fee = saleFeeConfig(sale)
    const feeMinor = isFreeInstallmentFee(fee)
      ? 0n
      : computeInstallmentFeeMinor(sale.priceMinor - sale.depositMinor, fee)
    const summed = sale.scheduleEntries.reduce((total, e) => total + e.amountDueMinor, 0n)
    const pricePlusFee = sale.priceMinor + feeMinor

    console.log(
      [
        `  ${sale.buyer.fullName.padEnd(14)}`,
        `${sale.project.name.padEnd(16)}`,
        `unit ${sale.unit.name.padEnd(4)}`,
        `${sale.planType.padEnd(12)}`,
        `mode=${sale.feeMode.padEnd(7)}`,
        `charge=${installmentFeeSummary(fee, sale.currency).padEnd(14)}`,
        `fee=${formatMinor(feeMinor, sale.currency).padEnd(16)}`,
        `Sum(entries)=${formatMinor(summed, sale.currency).padEnd(18)}`,
        `price+fee=${formatMinor(pricePlusFee, sale.currency).padEnd(18)}`,
        summed === pricePlusFee ? 'EQUAL' : `MISMATCH by ${summed - pricePlusFee}`
      ].join(' ')
    )

    // Loud rather than cosmetic: a seed whose schedule does not sum to the
    // price plus the charge is a broken demo of a broken invariant.
    if (summed !== pricePlusFee) {
      throw new Error(
        `Schedule invariant violated for ${sale.buyer.fullName}: entries sum to ${summed}, price+fee is ${pricePlusFee}`
      )
    }
  }

  console.log('\nSeeded:', {
    org: org.name,
    projects: `2 (Sunrise Heights fixed ₦2,500,000, Riverside Court 10%)`,
    units: await prisma.unit.count(),
    sales: await prisma.sale.count(),
    scheduleEntries: await prisma.scheduleEntry.count(),
    payments: await prisma.payment.count(),
    documents: await prisma.document.count(),
    documentSeq: (await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { documentSeq: true }
    })).documentSeq,
    admin: admin.email,
    agent: agent.email
  })
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
