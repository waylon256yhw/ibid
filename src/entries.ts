/** Shared text boundaries for citation contexts and bibliography entries. */
export const NUMBERED = /^\s*(?:[[［](\d+)[\]］]\s*|(\d+)(?:[.)．]\s+|[、\t]\s*))(?=\S)/
export const LIST_MARKER = new RegExp(`${NUMBERED.source}|^\\s*[-*+•]\\s`)
export const REFERENCE_HEADING = /^[#*\s]*(?:\d+[.)]?\s*)?(?:(?:supplementary|supporting)\s+)?(?:references?(?:\s+(?:list|cited|and\s+notes))?|bibliography|literature\s+cited|works\s+cited|参考文献|引用文献)[\s*:：]*$/i
const MAX_STEP = 10
const heading = (line: string) => REFERENCE_HEADING.test(line) || /^\s*#{1,6}\s/.test(line)

export type ListEntry = { line: number; endLine: number; entryNumber?: number; text: string }

/** Exclusive end of an item starting at a 0-based line; shared with identifier contexts. */
const itemEnd = (lines: ReadonlyArray<string>, start: number) => {
  let end = start + 1
  while (end < lines.length && lines[end]!.trim() && !LIST_MARKER.test(lines[end]!) && !heading(lines[end]!)) end++
  return end
}

/** Entries stop at a blank line, another item, or an explicit heading. Lines are 1-based. */
export const listEntries = (text: string): Array<ListEntry> => {
  const lines = text.split("\n")
  return lines.flatMap((line, i) => {
    if (!LIST_MARKER.test(line) || heading(line)) return []
    const number = NUMBERED.exec(line)
    const end = itemEnd(lines, i)
    return [{ line: i + 1, endLine: end, ...(number && { entryNumber: Number(number[1] ?? number[2]) }),
      text: lines.slice(i, end).join("\n").replace(LIST_MARKER, "").trim() }]
  })
}

/** Preserve numbering's selection rule: first run after the last reference heading, else longest run. */
export const numberedReferences = (text: string, entries = listEntries(text)) => {
  const runs: Array<Array<ListEntry & { entryNumber: number }>> = []
  for (const entry of entries) {
    if (entry.entryNumber === undefined) continue
    const it = { ...entry, entryNumber: entry.entryNumber }
    const last = runs.at(-1)?.at(-1)
    if (last && last.entryNumber <= it.entryNumber && it.entryNumber <= last.entryNumber + MAX_STEP) runs.at(-1)!.push(it)
    else runs.push([it])
  }
  const candidates = runs.filter((r) => r.length >= 2)
  const h = text.split("\n").findLastIndex((l) => REFERENCE_HEADING.test(l)) + 1
  return (h > 0 ? candidates.find((r) => r[0]!.line > h) ?? runs.find((r) => r[0]!.line > h) : undefined)
    ?? candidates.reduce<typeof candidates[number] | undefined>((a, b) => a && a.length > b.length ? a : b, undefined) ?? []
}

/** Explicit bibliography blocks need no identifiers; unheaded blocks require an identified majority. */
export const referenceEntries = (text: string, identifiedStarts: ReadonlySet<number>) => {
  const lines = text.split("\n")
  const entries = listEntries(text)
  const blocks: Array<Array<ListEntry>> = []
  for (const entry of entries) {
    const previous = blocks.at(-1)?.at(-1)
    if (previous && lines.slice(previous.endLine, entry.line - 1).every((l) => !l.trim())) blocks.at(-1)!.push(entry)
    else blocks.push([entry])
  }
  const explicit = blocks.filter((b) => {
    let before = b[0]!.line - 2
    while (before >= 0 && !lines[before]!.trim()) before--
    return before >= 0 && REFERENCE_HEADING.test(lines[before]!)
  }).flat()
  const selected = new Set(explicit.map((e) => e.line))
  for (const block of blocks) if (block.filter((e) => identifiedStarts.has(e.line - 1)).length * 2 > block.length) {
    for (const entry of block) selected.add(entry.line)
  }
  return entries.filter((e) => selected.has(e.line))
}

/** Inclusive 0-based context boundaries; table rows stay independent. */
export const contextRange = (lines: ReadonlyArray<string>, at: number) => {
  if (/^\s*\|/.test(lines[at]!)) return [at, at] as const
  const blank = (i: number) => !lines[i]!.trim() || heading(lines[i]!)
  let start = at
  let end = at
  while (start > 0 && !blank(start - 1)) start--
  while (end < lines.length - 1 && !blank(end + 1)) end++
  let marker = at
  while (marker >= start && !LIST_MARKER.test(lines[marker]!)) marker--
  if (marker >= start) {
    start = marker
    end = itemEnd(lines, marker) - 1
  }
  return [start, end] as const
}

export const contextAt = (text: string, line: number) => {
  const lines = text.split("\n")
  const [start, end] = contextRange(lines, line - 1)
  return lines.slice(start, end + 1).join("\n")
}
