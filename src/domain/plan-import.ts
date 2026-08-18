/**
 * Which units a page of a developer's PDF appears to be the floor plan for.
 *
 * Pure: text in, unit ids out. No pdf.js, no DOM, no clock — the suggestion is
 * a decision about words, and it is the only part of the import worth testing,
 * so it lives apart from the canvas that produced the words.
 *
 * A suggestion is never applied on its own: the importer pre-ticks what this
 * returns and the admin confirms it. That is why ambiguity returns nothing
 * rather than a best guess — a wrong pre-tick that someone accepts is worse
 * than an empty one they have to complete, because only one of the two is
 * visible as a decision.
 */

export interface SuggestableUnit {
  id: string
  bedrooms: number
}

/** Developers write the count either way, so both are read. */
const SPELLED: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6
}

/**
 * `3 BEDROOM`, `3-bedroom`, `3 BEDROOMS`, `4 BED`, `THREE BEDROOM`.
 *
 * The separator class includes an en dash because typeset plans use one, and
 * the trailing `\b` keeps `BEDSIT` from reading as a bed count.
 */
const BEDROOM = /(\d{1,2}|one|two|three|four|five|six)[\s\-–]*bed(?:room)?s?\b/gi

/** Above this, the "count" is a room number or a dimension, not a bedroom count. */
const MAX_PLAUSIBLE_BEDROOMS = 12

/** Distinct bedroom counts the text names, ascending. */
export function bedroomCountsInText(text: string): number[] {
  const counts = new Set<number>()

  for (const match of text.matchAll(BEDROOM)) {
    const token = match[1].toLowerCase()
    const value = /^\d+$/.test(token) ? Number(token) : SPELLED[token]
    if (value !== undefined && value > 0 && value <= MAX_PLAUSIBLE_BEDROOMS) {
      counts.add(value)
    }
  }

  return [...counts].sort((a, b) => a - b)
}

/**
 * The units a page is suggested for: every unit whose bedroom count matches,
 * but only when the page names exactly one count. Two counts means the page is
 * a comparison or a schedule, and none means it is a plate, a cover or an
 * amenity page — neither is a floor plan for a particular unit.
 */
export function suggestUnitsForPage(text: string, units: SuggestableUnit[]): string[] {
  const counts = bedroomCountsInText(text)
  if (counts.length !== 1) return []

  const bedrooms = counts[0]
  return units.filter((unit) => unit.bedrooms === bedrooms).map((unit) => unit.id)
}
