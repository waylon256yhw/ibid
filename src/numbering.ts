import { normalizeTitle, similarity } from "./resolve.ts"
import { extractIds } from "./verify.ts"
import { NUMBERED, numberedReferences } from "./entries.ts"

export type NumberingKind = "missing-entry" | "uncited" | "out-of-order" | "gap" | "repeated" | "duplicate"
/** `line` is 1-based. */
export type NumberingFinding = { kind: NumberingKind; numbers: Array<number>; line: number; message: string }
/**
 * `checked` with no findings means the numbering is clean. `no-list` and `no-citations` mean there was
 * nothing to check: no numbered reference list, or a list but no numeric citation markers outside it.
 */
export type NumberingResult = {
  status: "checked" | "no-list" | "no-citations"
  message: string
  entries: number
  citations: number
  findings: Array<NumberingFinding>
}


const DASH = /[-–—−~～－]/
const SEP = /[,，、;；]/
/** `[1]`, `[3,4]`, `[5-7]`, `[5–7, 9]`, `［1，2］`. */
const MARKER = /[[［]\s*(\d+(?:\s*[-–—−~～－]\s*\d+)?(?:\s*[,，、;；]\s*\d+(?:\s*[-–—−~～－]\s*\d+)?)*)\s*[\]］]/g

/** Entry texts at least this similar (after `normalizeTitle`) are the same work listed twice. */
const NEAR_IDENTICAL = 0.95

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const show = (ns: ReadonlyArray<number>) => ns.length > 2 && ns[ns.length - 1]! - ns[0]! === ns.length - 1 ? `${ns[0]}-${ns[ns.length - 1]}` : ns.join(", ")

/**
 * Checks numeric citation markers (`[1]`, `[3,4]`, `[5–7, 9]`, full-width forms) against the numbered
 * reference list of plain text, such as `docxText` output: one line per paragraph, or hard-wrapped
 * text where an entry runs on until a blank line or the next item.
 *
 * Finding the list: list items form a run while each number is equal to the previous one or at most
 * `MAX_STEP` above it, whatever text lies between them. After the last heading such as "References",
 * "Supplementary References" or "参考文献", the reference list is the first run of at least two items,
 * or of one item when none is longer; without such a heading (or no run after it), the longest run of
 * at least two items, the later one on a tie. So protocol steps or numbered section headings before
 * the list do not count, nor does a shorter numbered list after it.
 *
 * Citations are the markers on every line that is not part of a list entry. A marker at the start of
 * a list item line is that item's number, not a citation. A bracket holding 0, or a single number of
 * 1000 or more (an interval such as `[0, 1]`, a year), is not a citation.
 */
export const checkNumbering = (text: string): NumberingResult => {
  const lines = text.split("\n")
  const list = numberedReferences(text)
  const none = { entries: 0, citations: 0, findings: [] }
  if (!list.length) return { status: "no-list", message: "no numbered reference list found", ...none }
  const inList = new Set<number>()
  const entries = list.map((entry) => {
    for (let i = entry.line - 1; i < entry.endLine; i++) inList.add(i)
    return { n: entry.entryNumber, line: entry.line, text: entry.text }
  })

  const cites: Array<{ n: number; line: number }> = []
  lines.forEach((l, i) => {
    if (inList.has(i)) return
    for (const m of l.matchAll(MARKER)) {
      if (m.index === l.search(/\S/) && NUMBERED.test(l)) continue
      const ns = m[1]!.split(SEP).flatMap((part) => {
        const [a, b] = part.split(DASH).map((s) => Number(s.trim())) as [number, number | undefined]
        return b === undefined ? [a] : b >= a && b - a < 100 ? range(a, b) : [a, b]
      })
      if (ns.includes(0) || (ns.length === 1 && ns[0]! >= 1000)) continue
      for (const n of ns) cites.push({ n, line: i + 1 })
    }
  })
  if (cites.length === 0) {
    return { status: "no-citations", message: `reference list of ${entries.length} entries found, but no numeric citation markers such as [1]`, ...none, entries: entries.length }
  }

  const findings: Array<NumberingFinding> = []
  const add = (kind: NumberingKind, numbers: Array<number>, line: number, message: string) => findings.push({ kind, numbers, line, message })

  // The list itself.
  if (entries[0]!.n > 1) add("gap", range(1, entries[0]!.n - 1), entries[0]!.line, `reference list starts at ${entries[0]!.n}; no entry ${show(range(1, entries[0]!.n - 1))}`)
  entries.forEach((e, k) => {
    const prev = entries[k - 1]
    if (!prev) return
    if (e.n === prev.n) add("repeated", [e.n], e.line, `entry number ${e.n} is used twice (lines ${prev.line} and ${e.line})`)
    else if (e.n > prev.n + 1) add("gap", range(prev.n + 1, e.n - 1), e.line, `no entry ${show(range(prev.n + 1, e.n - 1))} between ${prev.n} and ${e.n}`)
  })

  // Citations against entries. `first` keeps reading order.
  const numbers = new Set(entries.map((e) => e.n))
  const first = new Map<number, number>()
  for (const c of cites) if (!first.has(c.n)) first.set(c.n, c.line)
  for (const [n, line] of first) if (!numbers.has(n)) add("missing-entry", [n], line, `[${n}] is cited but the reference list has no entry ${n}`)
  for (const e of entries) {
    if (!first.has(e.n) && entries.find((x) => x.n === e.n) === e) add("uncited", [e.n], e.line, `entry ${e.n} is never cited`)
  }
  // A work is out of order when it is first cited after a higher-numbered one. Numbers without an
  // entry are left out, so a typo is reported once, as a missing entry.
  let max = 0
  for (const [n, line] of first) {
    if (!numbers.has(n)) continue
    if (n < max) add("out-of-order", [n, max], line, `[${n}] is first cited after [${max}]`)
    max = Math.max(max, n)
  }

  // The same work listed twice: a shared DOI or PMID, or near-identical text unless both carry a DOI
  // and the DOIs differ. Each entry joins the group of the first earlier entry it matches.
  const ids = entries.map((e) => new Set(extractIds(e.text).map((f) => f.key)))
  const norm = entries.map((e) => normalizeTitle(e.text))
  const dois = (s: Set<string>) => [...s].filter((k) => k.startsWith("doi:"))
  const group = entries.map((_, j) => {
    for (let i = 0; i < j; i++) {
      if ([...ids[j]!].some((k) => ids[i]!.has(k))) return { of: i, why: "same identifier" }
      const [a, b] = [dois(ids[i]!), dois(ids[j]!)]
      if (a.length && b.length) continue
      if (norm[j] && similarity(norm[i]!, norm[j]!) >= NEAR_IDENTICAL) return { of: i, why: "near-identical text" }
    }
    return undefined
  })
  const root = (j: number): number => group[j] ? root(group[j]!.of) : j
  const groups = new Map<number, Array<number>>()
  group.forEach((g, j) => {
    if (g) groups.set(root(j), [...groups.get(root(j)) ?? [root(j)], j])
  })
  for (const members of groups.values()) {
    const later = members[1]!
    add("duplicate", members.map((k) => entries[k]!.n), entries[later]!.line, `entries ${members.map((k) => entries[k]!.n).join(", ")} are the same work (${group[later]!.why})`)
  }

  findings.sort((a, b) => a.line - b.line)
  return {
    status: "checked",
    message: `${entries.length} entries, ${cites.length} citations: ${findings.length ? `${findings.length} finding${findings.length > 1 ? "s" : ""}` : "numbering is clean"}`,
    entries: entries.length,
    citations: cites.length,
    findings
  }
}
