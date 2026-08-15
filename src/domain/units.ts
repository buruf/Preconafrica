export class UnitPatternError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnitPatternError'
  }
}

export interface UnitNameInput {
  floors: number
  unitsPerFloor: number
  pattern: string
  startFloor: number
}

export interface GeneratedUnit {
  name: string
  floor: number
  indexOnFloor: number
}

export const UNIT_PATTERN_PRESETS: ReadonlyArray<{
  label: string
  pattern: string
  example: string
}> = Object.freeze([
  { label: 'Numbered (401, 402)', pattern: '{floor}{index:02}', example: '401' },
  { label: 'Lettered (4A, 4B)', pattern: '{floor}{letter}', example: '4A' },
  // The owner's own building, Khaleel Suites, is numbered this way: the
  // position's letter leads, then the floor, then the position again as a
  // padded count — A101, B102, C103, D104 across floor 1. A common East
  // African convention, and no existing preset could express it.
  {
    label: 'Lettered + numbered (A101, B102)',
    pattern: '{letter}{floor}{index:02}',
    example: 'A101'
  },
  { label: 'Named (Unit 4-1)', pattern: 'Unit {floor}-{index}', example: 'Unit 4-1' }
])

/**
 * The three repeated form fields that carry one row per unit position.
 *
 * Here rather than beside the schema in `server/services/projects.ts` for one
 * reason: the form that writes these names is a client component, and it must
 * not import a module that pulls in Prisma and the session stack just to learn
 * three strings. The domain is the one place both sides can see, and a unit
 * position is a unit-generation concept — row *i* is `indexOnFloor` *i*, which
 * is exactly what `generateUnitNames` numbers.
 */
export const UNIT_TYPE_FIELDS = {
  bedrooms: 'unitTypeBedrooms',
  sizeSqm: 'unitTypeSizeSqm',
  price: 'unitTypePrice'
} as const

const TOKEN = /\{([a-zA-Z]+)(?::(\d+))?\}/g
const KNOWN_TOKENS = new Set(['floor', 'index', 'letter'])
const PER_UNIT_TOKENS = ['index', 'letter']

/** 1 → A, 26 → Z, 27 → AA. Spreadsheet-style, so it never wraps into a duplicate. */
export function columnLetters(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`columnLetters requires a positive integer, received ${n}`)
  }

  let result = ''
  let remaining = n
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    remaining = Math.floor((remaining - 1) / 26)
  }
  return result
}

function assertPattern(pattern: string, floors: number): void {
  const found: string[] = []
  for (const match of pattern.matchAll(TOKEN)) {
    const token = match[1]
    if (!KNOWN_TOKENS.has(token)) {
      throw new UnitPatternError(
        `Unknown token {${token}}. Supported tokens: {floor}, {index}, {letter}, with optional padding such as {index:02}.`
      )
    }
    found.push(token)
  }

  if (!found.some((token) => PER_UNIT_TOKENS.includes(token))) {
    throw new UnitPatternError(
      'Pattern must contain {index} or {letter}, otherwise every unit on a floor gets the same name.'
    )
  }

  if (floors > 1 && !found.includes('floor')) {
    throw new UnitPatternError(
      `Pattern must contain {floor} when generating more than one floor (floors: ${floors}), otherwise every floor repeats the same set of names.`
    )
  }
}

function expand(pattern: string, floor: number, indexOnFloor: number): string {
  return pattern.replace(TOKEN, (_full, token: string, pad?: string) => {
    const value =
      token === 'floor' ? String(floor)
      : token === 'index' ? String(indexOnFloor)
      : columnLetters(indexOnFloor)
    return pad ? value.padStart(Number(pad), '0') : value
  })
}

export function generateUnitNames(input: UnitNameInput): GeneratedUnit[] {
  const { floors, unitsPerFloor, pattern, startFloor } = input

  if (!Number.isInteger(floors) || floors < 1) {
    throw new UnitPatternError('floors must be an integer of at least 1')
  }
  if (!Number.isInteger(unitsPerFloor) || unitsPerFloor < 1) {
    throw new UnitPatternError('unitsPerFloor must be an integer of at least 1')
  }
  if (!Number.isInteger(startFloor)) {
    throw new UnitPatternError('startFloor must be an integer')
  }

  assertPattern(pattern, floors)

  const units: GeneratedUnit[] = []
  for (let f = 0; f < floors; f++) {
    const floor = startFloor + f
    for (let indexOnFloor = 1; indexOnFloor <= unitsPerFloor; indexOnFloor++) {
      units.push({ name: expand(pattern, floor, indexOnFloor), floor, indexOnFloor })
    }
  }

  const seen = new Map<string, GeneratedUnit>()
  for (const unit of units) {
    const clash = seen.get(unit.name)
    if (clash) {
      throw new UnitPatternError(
        `Pattern "${pattern}" produced the name "${unit.name}" more than once (floor ${clash.floor} unit ${clash.indexOnFloor} and floor ${unit.floor} unit ${unit.indexOnFloor}). Add more padding or a separator so names stay distinct.`
      )
    }
    seen.set(unit.name, unit)
  }

  return units
}

/**
 * The names positions 1..unitsPerFloor will carry on the *first* floor.
 *
 * This exists for one screen: the new-project form now takes a row of
 * bedrooms/size/price per unit position, and an admin filling in four rows has
 * no way to know whether row 3 is the C unit or the D unit without being shown.
 * Row *i* maps to `indexOnFloor` *i*, which is exactly what `generateUnitNames`
 * numbers, so the preview is the real generator run over a single floor rather
 * than a second, driftable implementation of the same rule.
 *
 * Never throws. It renders live beside a form whose pattern and start floor can
 * be mid-edit, and a preview label is not worth crashing a form over — an
 * unusable pattern comes back as an empty list and the rows simply lose their
 * captions. The pattern is still validated for real by `CreateProjectSchema`
 * and again by `createProject`.
 *
 * `floors: 1` deliberately relaxes the cross-floor {floor}-token requirement:
 * one floor cannot collide with another, and this is a preview of one floor.
 */
export function firstFloorUnitNames(input: {
  unitsPerFloor: number
  pattern: string
  startFloor: number
}): string[] {
  try {
    return generateUnitNames({
      floors: 1,
      unitsPerFloor: input.unitsPerFloor,
      pattern: input.pattern,
      startFloor: input.startFloor
    }).map((unit) => unit.name)
  } catch {
    return []
  }
}
