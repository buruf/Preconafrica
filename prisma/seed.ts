import { PrismaClient, type PaymentMethod, type PlanType } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { toMinor } from '../src/domain/currency'
import { allocatePayment } from '../src/domain/allocation'
import { generateSchedule } from '../src/domain/schedule'
import { generateUnitNames } from '../src/domain/units'

const prisma = new PrismaClient()
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

async function main() {
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
   * through the real allocation function.
   *
   * NOTE (temporary duplication): this hand-rolls "write allocations, then
   * recompute amountPaidMinor and paidAt" the same way Task 13's
   * `applyAllocations` (src/server/services/payments.ts) will. That service
   * does not exist yet, so the seed cannot call it. Task 13 should refactor
   * this seed to call the real service once it lands.
   */
  async function createSale(opts: {
    projectId: string
    currency: string
    buyerId: string
    unitName: string
    planType: PlanType
    depositMajor: string
    termMonths: number | null
    signedAt: Date
    payments: Array<{ amountMajor: string; receivedAt: Date; method: PaymentMethod; reference: string }>
  }) {
    const unit = await prisma.unit.findFirstOrThrow({
      where: { projectId: opts.projectId, name: opts.unitName }
    })

    const depositMinor = toMinor(opts.depositMajor, opts.currency)
    const drafts = generateSchedule({
      planType: opts.planType,
      priceMinor: unit.priceMinor,
      depositMinor,
      months: opts.termMonths ?? 0,
      signedAt: opts.signedAt
    })

    const sale = await prisma.sale.create({
      data: {
        orgId: org.id,
        projectId: opts.projectId,
        unitId: unit.id,
        buyerId: opts.buyerId,
        planType: opts.planType,
        priceMinor: unit.priceMinor,
        depositMinor,
        currency: opts.currency,
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

      const { allocations } = allocatePayment(
        entries.map((e) => ({
          id: e.id,
          sequence: e.sequence,
          amountDueMinor: e.amountDueMinor,
          amountPaidMinor: e.amountPaidMinor
        })),
        toMinor(p.amountMajor, opts.currency)
      )

      const payment = await prisma.payment.create({
        data: {
          orgId: org.id,
          saleId: sale.id,
          amountMinor: toMinor(p.amountMajor, opts.currency),
          receivedAt: p.receivedAt,
          method: p.method,
          reference: p.reference,
          recordedByUserId: agent.id,
          allocations: { create: allocations.map((a) => ({ scheduleEntryId: a.entryId, amountMinor: a.amountMinor })) }
        }
      })

      for (const allocation of allocations) {
        const entry = entries.find((e) => e.id === allocation.entryId)!
        const newPaid = entry.amountPaidMinor + allocation.amountMinor
        await prisma.scheduleEntry.update({
          where: { id: allocation.entryId },
          data: {
            amountPaidMinor: newPaid,
            paidAt: newPaid >= entry.amountDueMinor ? p.receivedAt : null
          }
        })
      }
      void payment
    }

    return sale
  }

  const amina = await createBuyer('Amina Yusuf', 'amina@buyer.test', '+2348031234567', '14 Admiralty Way, Lekki, Lagos')
  const kwame = await createBuyer('Kwame Mensah', 'kwame@buyer.test', '+254712345678', 'Riverside Drive, Nairobi')
  const zainab = await createBuyer('Zainab Bello', 'zainab@buyer.test', '+2347098765432', null)
  const joseph = await createBuyer('Joseph Otieno', 'joseph@buyer.test', '+254733222111', 'Ngong Road, Nairobi')

  // 1. Full payment, settled.
  // Unit '101' is the deliberate choice: indexOnFloor 1 -> 2 bedrooms ->
  // 145,000,000 NGN, which is exactly the payment amount below. Unit '102'
  // (3 bedrooms, 250,000,000 NGN) would leave this "settled" sale half paid.
  await createSale({
    projectId: lagos.id, currency: 'NGN', buyerId: amina.id, unitName: '101',
    planType: 'FULL', depositMajor: '0', termMonths: null, signedAt: utc(2026, 3, 2),
    payments: [{ amountMajor: '145000000', receivedAt: utc(2026, 3, 2), method: 'BANK_TRANSFER', reference: 'GTB/2026/03/0021' }]
  })

  // 2. 36-month plan, fully current — five installments paid on time.
  // Unit '2A' (2 bedrooms, 11,200,000 KES) is what makes the ~255,556 KES
  // monthly payment below line up with the generated schedule's installment
  // amount; '2B' is a 3-bedroom unit priced too high for that to hold.
  await createSale({
    projectId: nairobi.id, currency: 'KES', buyerId: kwame.id, unitName: '2A',
    planType: 'INSTALLMENTS', depositMajor: '2000000', termMonths: 36, signedAt: utc(2026, 2, 15),
    payments: [1, 2, 3, 4, 5].map((m) => ({
      amountMajor: '255556', receivedAt: utc(2026, 2 + m, 15), method: 'MOBILE_MONEY' as PaymentMethod,
      reference: `MPESA-RJ${m}K4T2X9`
    }))
  })

  // 3. Partial payment outstanding on the current installment.
  // Unit '303' (1 bedroom, 85,000,000 NGN) makes the first payment below
  // exactly settle installment 1 and the second payment land partway into
  // installment 2 — the fully-paid-then-partial cascade this fixture needs.
  await createSale({
    projectId: lagos.id, currency: 'NGN', buyerId: zainab.id, unitName: '303',
    planType: 'INSTALLMENTS', depositMajor: '25000000', termMonths: 36, signedAt: utc(2026, 5, 20),
    payments: [
      { amountMajor: '1666666.66', receivedAt: utc(2026, 6, 20), method: 'BANK_TRANSFER', reference: 'ZEN/2026/06/8841' },
      { amountMajor: '800000', receivedAt: utc(2026, 7, 22), method: 'BANK_TRANSFER', reference: 'ZEN/2026/07/9002' }
    ]
  })

  // 4. Several months in arrears, so the arrears report has content on day one.
  await createSale({
    projectId: nairobi.id, currency: 'KES', buyerId: joseph.id, unitName: '4C',
    planType: 'INSTALLMENTS', depositMajor: '1500000', termMonths: 36, signedAt: utc(2026, 1, 10),
    payments: [
      { amountMajor: '469445', receivedAt: utc(2026, 2, 10), method: 'CASH', reference: 'RCPT-0091' },
      { amountMajor: '469445', receivedAt: utc(2026, 3, 12), method: 'CASH', reference: 'RCPT-0114' }
    ]
  })

  console.log('Seeded:', {
    org: org.name,
    projects: 2,
    units: await prisma.unit.count(),
    sales: await prisma.sale.count(),
    scheduleEntries: await prisma.scheduleEntry.count(),
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
