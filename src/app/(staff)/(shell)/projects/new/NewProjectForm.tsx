'use client'

import { useMemo, useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import {
  Button,
  Card,
  CONTROL_CLASS,
  ErrorText,
  Field,
  PageHeader,
  Select
} from '@/components/ui'
import { SUPPORTED_CURRENCIES } from '@/domain/currency'
import { UNIT_PATTERN_PRESETS, UNIT_TYPE_FIELDS, firstFloorUnitNames } from '@/domain/units'
import { createProjectAction } from '../actions'

/** What the form opens on, and what the page falls back to. */
export const DEFAULT_UNITS_PER_FLOOR = 6
const MIN_UNITS_PER_FLOOR = 1
const MAX_UNITS_PER_FLOOR = 100

const DEFAULT_START_FLOOR = 1
const DEFAULT_PATTERN = UNIT_PATTERN_PRESETS[0].pattern

/** One unit position, as the three boxes on its row hold it. */
interface PositionDraft {
  bedrooms: string
  sizeSqm: string
  price: string
}

const BLANK_POSITION: PositionDraft = { bedrooms: '2', sizeSqm: '90.00', price: '' }

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Creating…' : 'Create project'}
    </Button>
  )
}

/**
 * Grows or shrinks the list of positions to `count`.
 *
 * Growing copies the last row rather than starting blank, because the reason
 * someone types 8 into "Units / floor" is usually a floor of eight broadly
 * similar flats — and the alternative is retyping the same three numbers eight
 * times. Shrinking keeps the rows from the top, so the positions that survive
 * are the ones whose names have not changed.
 */
function resize(rows: PositionDraft[], count: number): PositionDraft[] {
  if (count === rows.length) return rows
  if (count < rows.length) return rows.slice(0, count)

  const template = rows[rows.length - 1] ?? BLANK_POSITION
  return [...rows, ...Array.from({ length: count - rows.length }, () => ({ ...template }))]
}

function clampCount(raw: string): number | null {
  const value = Number(raw)
  if (!Number.isInteger(value)) return null
  if (value < MIN_UNITS_PER_FLOOR || value > MAX_UNITS_PER_FLOOR) return null
  return value
}

export function NewProjectForm({
  initialUnitsPerFloor = DEFAULT_UNITS_PER_FLOOR
}: {
  /**
   * How many position rows to render on the server. Ordinarily the default —
   * JavaScript takes over the moment "Units / floor" is touched. It is a prop
   * at all so a browser with no JavaScript can still ask for a different number
   * of rows, via the `?unitsPerFloor=` link in the <noscript> block below.
   */
  initialUnitsPerFloor?: number
}) {
  const [error, formAction] = useFormState(createProjectAction, undefined)

  // These three exist in state only so the rows and their name previews can
  // follow them. Every one of them is still an ordinary named input that posts
  // its own value — nothing here is the source of truth for what gets
  // submitted, which is what keeps the form honest when the state is never
  // updated because JavaScript never ran.
  const [unitsPerFloor, setUnitsPerFloor] = useState(initialUnitsPerFloor)
  const [startFloor, setStartFloor] = useState(DEFAULT_START_FLOOR)
  const [pattern, setPattern] = useState(DEFAULT_PATTERN)

  const [positions, setPositions] = useState<PositionDraft[]>(() =>
    resize([{ ...BLANK_POSITION }], initialUnitsPerFloor)
  )

  // The name each position will actually take on the first floor — A101, B102,
  // … — so nobody filling in four rows has to work out whether row 3 is the C
  // unit or the D one. Recomputed from the live pattern and start floor.
  const previewNames = useMemo(
    () => firstFloorUnitNames({ unitsPerFloor: positions.length, pattern, startFloor }),
    [positions.length, pattern, startFloor]
  )

  function updatePosition(index: number, patch: Partial<PositionDraft>) {
    setPositions((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  /** Row 1's control: every position becomes a copy of the first. */
  function applyFirstToAll() {
    setPositions((rows) => rows.map(() => ({ ...rows[0] })))
  }

  /** Every other row's control: take the values from the position above it. */
  function copyFromAbove(index: number) {
    setPositions((rows) => rows.map((row, i) => (i === index ? { ...rows[i - 1] } : row)))
  }

  return (
    <>
      <PageHeader
        title="New project"
        subtitle="Every unit is generated from the floors, the units per floor and the naming pattern below."
      />

      {/*
        The rows follow "Units / floor" with JavaScript. Without it they cannot,
        so this is the honest alternative rather than a broken form: reload the
        page with the number you want and the server renders that many rows.
        Submitting a mismatch is refused with a message that says so, so the
        worst case is a wasted submission, never a wrong building.
      */}
      <noscript>
        <Card className="mb-4">
          <form method="get" action="/projects/new" className="space-y-3">
            <Field
              label="Units per floor"
              name="unitsPerFloor"
              type="number"
              defaultValue={initialUnitsPerFloor}
              hint="JavaScript is off, so the unit-position rows below cannot follow this box as you type. Set the number here first and the page will come back with that many rows."
            />
            <Button type="submit" variant="secondary" className="w-full">
              Show this many unit positions
            </Button>
          </form>
        </Card>
      </noscript>

      <Card>
        <form action={formAction} className="space-y-4">
          <ErrorText>{error}</ErrorText>

          <Field label="Building name" name="name" required placeholder="Sunrise Heights" />
          <Field label="Location" name="location" required placeholder="Lekki Phase 1, Lagos" />

          <Field
            label="Currency"
            name="currency"
            required
            hint="Prices for this project are set and displayed in this currency."
          >
            <Select name="currency" required>
              {Object.keys(SUPPORTED_CURRENCIES).map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Expected completion" name="expectedCompletion" type="date" required />

          {/* The one imagery field in the app that is still paste-only, and
              deliberately: a stored image lives at
              `org/{orgId}/project/{projectId}/…`, and this project has no id
              until the form is submitted. Uploading first would mean either an
              unscoped path or a blob orphaned by every abandoned draft. So the
              photo is uploaded from the project's own page a moment later, which
              is also where an admin can see what they picked against the
              inventory it heads. */}
          <Field
            label="Building photo URL"
            name="heroImageUrl"
            type="url"
            placeholder="https://…/sunrise-heights.jpg"
            hint="Optional — an https link to a photo or render of the building. To upload one from your phone or computer instead, create the project and use “Add a building photo” on its page."
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Floors" name="floors" type="number" required defaultValue={4} />
            <Field
              label="Units / floor"
              name="unitsPerFloor"
              type="number"
              required
              defaultValue={initialUnitsPerFloor}
              onChange={(event) => {
                const next = clampCount(event.target.value)
                if (next === null) return
                setUnitsPerFloor(next)
                setPositions((rows) => resize(rows, next))
              }}
            />
            <Field
              label="First floor no."
              name="startFloor"
              type="number"
              required
              defaultValue={DEFAULT_START_FLOOR}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (Number.isInteger(next)) setStartFloor(next)
              }}
            />
          </div>

          <Field
            label="Unit naming pattern"
            name="namingPattern"
            required
            hint="{floor} is the floor number, {index:02} a zero-padded count, {letter} a letter."
          >
            <Select name="namingPattern" onChange={(event) => setPattern(event.target.value)}>
              {UNIT_PATTERN_PRESETS.map((preset) => (
                <option key={preset.pattern} value={preset.pattern}>
                  {preset.label}
                </option>
              ))}
            </Select>
          </Field>

          {/* One row per unit position, and the number of rows is "Units /
              floor". Row i is the unit numbered i on every floor, which is
              exactly what the name beside each row shows. */}
          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold text-ink">
                Unit positions ({positions.length} per floor)
              </h2>
              <p className="mt-1 text-[13px] text-muted">
                One row per position on a floor, in order. Each row applies to that position on
                every floor — the name beside it is what it will be called on the first floor.
                Individual units stay editable afterwards.
              </p>
            </div>

            {positions.map((position, index) => {
              const name = previewNames[index]
              return (
                <div
                  key={index}
                  className="space-y-3 rounded-btn border border-line bg-page p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">
                      Position {index + 1}
                      {name ? <span className="text-muted"> — {name}</span> : null}
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => (index === 0 ? applyFirstToAll() : copyFromAbove(index))}
                      disabled={positions.length < 2}
                    >
                      {index === 0 ? 'Apply to all' : 'Copy above'}
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field label="Bedrooms" name={UNIT_TYPE_FIELDS.bedrooms}>
                      <input
                        name={UNIT_TYPE_FIELDS.bedrooms}
                        type="number"
                        required
                        min={0}
                        max={10}
                        value={position.bedrooms}
                        onChange={(event) =>
                          updatePosition(index, { bedrooms: event.target.value })
                        }
                        className={CONTROL_CLASS}
                      />
                    </Field>
                    <Field label="Size (m²)" name={UNIT_TYPE_FIELDS.sizeSqm}>
                      <input
                        name={UNIT_TYPE_FIELDS.sizeSqm}
                        required
                        inputMode="decimal"
                        value={position.sizeSqm}
                        onChange={(event) => updatePosition(index, { sizeSqm: event.target.value })}
                        className={CONTROL_CLASS}
                      />
                    </Field>
                    <Field label="Price" name={UNIT_TYPE_FIELDS.price}>
                      <input
                        name={UNIT_TYPE_FIELDS.price}
                        required
                        inputMode="decimal"
                        placeholder="145000000"
                        value={position.price}
                        onChange={(event) => updatePosition(index, { price: event.target.value })}
                        className={CONTROL_CLASS}
                      />
                    </Field>
                  </div>
                </div>
              )
            })}

            {previewNames.length === 0 ? (
              <p className="text-[13px] text-muted">
                The unit names cannot be previewed until the naming pattern and first floor number
                are valid.
              </p>
            ) : null}

            {unitsPerFloor !== positions.length ? (
              <ErrorText>
                “Units / floor” is {unitsPerFloor} but there {positions.length === 1 ? 'is' : 'are'}{' '}
                {positions.length} position{positions.length === 1 ? '' : 's'} below. They have to
                match.
              </ErrorText>
            ) : null}
          </div>

          {/* Two modes, not one with a workaround. A percentage of the financed
              amount is interest, and interest is not permissible in several of
              the markets this platform is sold into — a developer there charges
              one flat fee for the service of spreading the payments. See
              `InstallmentFeeMode` in schema.prisma. */}
          <Field
            label="How installments are charged"
            name="installmentFeeMode"
            hint="A percentage of the financed amount, or one flat amount whatever the unit costs. Choose a fixed amount where charging interest is not permissible."
          >
            <Select name="installmentFeeMode">
              <option value="PERCENT">A percentage of the financed amount</option>
              <option value="FIXED">A fixed amount</option>
            </Select>
          </Field>

          <Field
            label="Installment charge (%)"
            name="installmentMarkupPercent"
            defaultValue="0"
            placeholder="10"
            hint="Used when the charge is a percentage. Charged on the financed amount (price less deposit). Up to two decimal places. Staff can override it on an individual sale."
          />

          <Field
            label="Fixed installment charge"
            name="installmentFixedFee"
            defaultValue="0"
            placeholder="2500000"
            hint="Used when the charge is a fixed amount. In the project's own currency, and it must be less than the amount a buyer finances. Staff can override it on an individual sale."
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Remind days before"
              name="reminderDaysBefore"
              type="number"
              required
              defaultValue={7}
            />
            <Field
              label="Overdue notice after"
              name="overdueNoticeDaysAfter"
              type="number"
              required
              defaultValue={3}
            />
          </div>

          <Submit />
        </form>
      </Card>
    </>
  )
}
