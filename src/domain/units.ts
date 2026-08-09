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
  { label: 'Named (Unit 4-1)', pattern: 'Unit {floor}-{index}', example: 'Unit 4-1' }
])

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

function assertPattern(pattern: string): void {
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

  assertPattern(pattern)

  const units: GeneratedUnit[] = []
  for (let f = 0; f < floors; f++) {
    const floor = startFloor + f
    for (let indexOnFloor = 1; indexOnFloor <= unitsPerFloor; indexOnFloor++) {
      units.push({ name: expand(pattern, floor, indexOnFloor), floor, indexOnFloor })
    }
  }
  return units
}
