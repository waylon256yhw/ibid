import { Effect, Exit, FileSystem } from "effect"
import { arxivId, citeLib } from "./export.ts"
import { docxText } from "./docx.ts"
import { findCandidates } from "./find.ts"
import { checkNumbering } from "./numbering.ts"
import { checkTitle, fetchCsl, mainTitle, normalizeTitle, parseId, similarity, TITLE_FUZZY_THRESHOLD } from "./resolve.ts"
import type { Csl } from "./schema.ts"
import { effective, findItem, itemKey, keyOf, plain, year } from "./store.ts"
import { usage } from "./ui.ts"

export type Status = "OK" | "MISMATCH" | "NOT_FOUND" | "UNIDENTIFIED" | "CHECK" | "ERROR"
export type Finding = { status: Status; location: string; id?: string; details: string }

// ---------- identifiers in prose ----------

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
const CLOSERS = new Set(Object.values(OPEN))

/**
 * Cuts the match at the first closing bracket that has no opening partner inside the DOI
 * (`10.1/a)` out of `(doi:10.1/a)`, `10.1/a),[2` out of two adjacent links), then drops
 * trailing punctuation. Balanced brackets, as in SICI DOIs, are kept.
 */
export const trimDoi = (raw: string) => {
  const open: Array<string> = []
  let cut = raw.length
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (OPEN[c]) open.push(OPEN[c])
    else if (CLOSERS.has(c) && open.pop() !== c) {
      cut = i
      break
    }
  }
  return raw.slice(0, cut).replace(/[.,;:!?'"*_]+$/, "")
}

/**
 * `near` is the text that may vouch for the identifier (see `extractIds`); `start` is the
 * first line (0-based) of its context and identifies that context.
 */
export type Found = { id: string; key: string; line: number; context: string; near: string; start: number }

/**
 * DOIs, `PMID: n` and `arXiv:id` in reading order, once per context (`contextAt`), each with
 * the line it first appears on there. The same id in two list items is judged in each.
 */
export const extractIds = (text: string): Array<Found> => {
  const out: Array<Found> = []
  const seen = new Set<string>()
  // Where the previous identifier of each context ended. When a context cites several works,
  // only the text between the previous identifier and this one can vouch for it, so neither
  // "Harris 2020 (doi:x) and Ching 2018 (doi:y)" nor two reference lines pass with x and y swapped.
  const last = new Map<number, { line: number; end: number }>()
  const lines = text.split("\n")
  lines.forEach((l, i) => {
    const hits = [
      // `<…>` only as a slash-free group, as in SICI DOIs (`36:2<123::aid-jbm1>3.0.co;2-x`), not `</a>`.
      // A match never runs across `](`, so a link's text and its target are read separately. It is
      // printable ASCII only, so it also ends at full-width punctuation and Chinese text.
      ...[...l.matchAll(/\b10\.\d{4,9}\/(?:[\x21\x23-\x3b\x3d\x3f-\x5c\x5e-\x7e]|\](?!\()|<[^\s"<>/]*>)+/g)].map((m) => {
        const doi = trimDoi(m[0])
        return { at: m.index, end: m.index + doi.length, id: `doi:${doi}` }
      }),
      ...[...l.matchAll(/\bPMID[:：]?\s*(\d+)\b/gi)].map((m) => ({ at: m.index, end: m.index + m[0].length, id: `pmid:${m[1]}` })),
      ...[...l.matchAll(/\barXiv[:：]\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/gi)].map((m) => ({ at: m.index, end: m.index + m[0].length, id: `arxiv:${m[1]}` }))
    ].sort((a, b) => a.at - b.at)
    for (const hit of hits) {
      const ref = Effect.runSyncExit(parseId(hit.id))
      if (Exit.isFailure(ref)) continue
      const key = keyOf(ref.value)
      const [start, end] = contextRange(lines, i)
      const prev = last.get(start) ?? { line: start, end: 0 }
      last.set(start, { line: i, end: hit.end })
      if (seen.has(`${key}@${start}`)) continue
      seen.add(`${key}@${start}`)
      const near = prev.line === i
        ? l.slice(prev.end, hit.at)
        : [lines[prev.line]!.slice(prev.end), ...lines.slice(prev.line + 1, i), l.slice(0, hit.at)].join("\n")
      out.push({ id: hit.id, key, line: i + 1, context: lines.slice(start, end + 1).join("\n"), near, start })
    }
  })
  // A context with a single identifier has nothing to confuse it with: the whole context counts.
  const perContext = new Map<number, number>()
  for (const f of out) perContext.set(f.start, (perContext.get(f.start) ?? 0) + 1)
  return out.map((f) => perContext.get(f.start) === 1 ? { ...f, near: f.context } : f)
}

/**
 * The marker of a numbered list item, with the number in group 1 or 2: `1. `, `1) `, `1．`, `1、`,
 * `1<tab>` (how textutil writes Word's numbered lists), `[1]`, `［1］`. The numbering check uses
 * the same pattern, so both agree on what a reference entry is.
 */
export const NUMBERED = /^\s*(?:[[［](\d+)[\]］]\s*|(\d+)(?:[.)．]\s+|[、\t]\s*))(?=\S)/
/** A numbered item or a bullet. */
const LIST_MARKER = new RegExp(`${NUMBERED.source}|^\\s*[-*+•]\\s`)

/**
 * The text an identifier on 1-based `line` belongs to: its table row, or its list item (marker line plus
 * continuation lines up to the next marker) when the line is in a list, else its
 * blank-line-separated paragraph.
 */
export const contextAt = (text: string, line: number) => {
  const lines = text.split("\n")
  const [start, end] = contextRange(lines, line - 1)
  return lines.slice(start, end + 1).join("\n")
}

/** First and last 0-based line of `contextAt`. */
const contextRange = (lines: ReadonlyArray<string>, at: number) => {
  // A Markdown table row is one entry on one line.
  if (/^\s*\|/.test(lines[at]!)) return [at, at] as const
  const blank = (i: number) => lines[i]!.trim() === ""
  let start = at
  let end = at
  while (start > 0 && !blank(start - 1)) start--
  while (end < lines.length - 1 && !blank(end + 1)) end++
  let marker = at
  while (marker >= start && !LIST_MARKER.test(lines[marker]!)) marker--
  if (marker >= start) {
    start = marker
    end = at
    while (end < lines.length - 1 && !blank(end + 1) && !LIST_MARKER.test(lines[end + 1]!)) end++
  }
  return [start, end] as const
}

/** 1 for an exact (normalized) occurrence, else the best `similarity` of a same-length window starting at a word. */
export const titleScore = (title: string, text: string) => {
  const t = normalizeTitle(title)
  const s = normalizeTitle(text)
  // Chinese has no spaces between words, so there a plain substring is an occurrence.
  if (HAN.test(t) ? s.includes(t) : ` ${s} `.includes(` ${t} `)) return 1
  let best = 0
  for (let i = 0; i <= s.length; i = s.indexOf(" ", i) + 1 || s.length + 1) {
    best = Math.max(best, similarity(t, s.slice(i, i + t.length)))
  }
  return Math.round(best * 1000) / 1000
}

const HAN = /\p{Script=Han}/u

/** Why `near` supports the registry record (its title, or its first author and year), or undefined when it does not. */
export const textEvidence = (csl: Csl, near: string) => {
  const score = titleScore(plain(csl.title), near)
  if (score === 1) return "title found"
  if (score >= TITLE_FUZZY_THRESHOLD) return `title found (similarity ${score})`
  // A reference may give only the main title of a registry title with a subtitle.
  const main = mainTitle(plain(csl.title))
  if (main && main.length >= 10 && titleScore(main, near) === 1) return "main title found"
  const family = firstFamily(csl)
  const words = ` ${normalizeTitle(near)} `
  const name = family && normalizeTitle(family)
  const hasName = name && (HAN.test(name) ? words.includes(name) : words.includes(` ${name} `))
  // Digit boundaries rather than spaces, so `2011年` counts.
  const y = hasName && years(csl).find((n) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(words))
  return y ? `first author ${family} and year ${y} found` : undefined
}

/** The issue year, then the online-first year when it differs. */
export const years = (c: Partial<Csl>) =>
  [year(c as Csl), c["issued-online"]?.["date-parts"][0]?.[0]].filter((y) => y !== undefined)

// Identifiers and links carry digits that could pass for a volume or page.
const stripIds = (s: string) =>
  s.replace(LIST_MARKER, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\b10\.\d{4,9}\/\S+/g, " ")
    .replace(/\b(?:PMID[:：]?\s*\d+|PMCID[:：]?\s*PMC\d+|arXiv[:：]\s*\S+)/gi, " ")

/** `v` as a whole token of `s`; a number may carry a prefix such as `e` (`e2301006`) or leading zeros. */
const hasToken = (s: string, v: string) => {
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(/^\d+$/.test(v) ? `(?<!\\d)0*${esc}(?!\\d)` : `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu").test(s)
}

/**
 * For a reference entry: the registry's year (either), volume, and first page or article number, each
 * only when the registry has it, that `entry` does not show. `2057-62` and `e2301006` both pass.
 */
export const missingDetails = (csl: Csl, entry: string) => {
  const text = stripIds(entry)
  const ys = years(csl).map(String)
  const pages = [firstPage(csl.page), firstPage(csl["article-number"])].filter((p) => p !== undefined)
  const volume = num(csl.volume)
  return [
    ys.length && !ys.some((y) => hasToken(text, y)) && `year ${ys.join(" or ")}`,
    volume && !hasToken(text, volume) && `volume ${volume}`,
    pages.length && !pages.some((p) => hasToken(text, p)) && `page or article number ${[...new Set(pages)].join(" or ")}`
  ].filter((m) => typeof m === "string")
}

// ---------- .bib entries ----------

type BibEntry = Partial<Csl> & { "citation-key"?: string; id?: string }

const num = (v: unknown) => v === undefined || v === null || String(v).trim() === "" ? undefined : String(v).trim().replace(/^0+(?=\d)/, "")
/** A leading `e` before digits is an electronic locator: `e2301006` is page `2301006`. */
const firstPage = (p: string | undefined) => num(p?.split(/[-–—,]/)[0]?.trim().replace(/^e(?=\d)/i, ""))
const firstFamily = (c: Partial<Csl>) => {
  const a = c.author?.[0]
  return a ? a.family ?? a.literal ?? a.given : undefined
}

const STOP = new Set(["of", "the", "and", "for", "in", "on", "at", "a", "an", "et", "de", "und", "fur"])

/**
 * Journal names: equal or fuzzily equal after normalization, or an abbreviation where every
 * claimed word starts the corresponding registry word, stop words dropped (`J R Soc Interface`).
 * Parenthetical groups are dropped first: a place (`Antioxidants (Basel)`) or a series acronym (`(BBA)`).
 */
export const sameJournal = (claimed: string, registry: string) => {
  const a = normalizeTitle(claimed.replace(/\([^)]*\)/g, " "))
  const b = normalizeTitle(registry.replace(/\([^)]*\)/g, " "))
  if (a === b || similarity(a, b) >= TITLE_FUZZY_THRESHOLD) return true
  const words = (s: string) => s.split(" ").filter((w) => w && !STOP.has(w))
  const [x, y] = [words(a), words(b)]
  const abbreviates = (short: ReadonlyArray<string>, long: ReadonlyArray<string>) =>
    short.length > 0 && short.length === long.length && short.every((w, i) => long[i]!.startsWith(w))
  // Either side may be the short form, and either may be a single word that is the other's acronym
  // (`PNAS`, `NEJM`; Crossref calls J Am Coll Cardiol `JACC`).
  const acronym = (one: ReadonlyArray<string>, many: ReadonlyArray<string>) =>
    one.length === 1 && many.length > 1 && one[0] === many.map((w) => w[0]).join("")
  return abbreviates(x, y) || abbreviates(y, x) || acronym(x, y) || acronym(y, x)
}

/** `registry` is absent when the registry record lacks a field the entry claims. */
export type FieldDiff = { field: string; claimed: string; registry?: string }

/**
 * Claimed fields the registry contradicts (title by the `checkTitle` rule, year, first author
 * family name, journal or booktitle, volume, issue, first page), and claimed fields it lacks.
 */
export const compareEntry = (claimed: Partial<Csl>, registry: Csl): Array<FieldDiff> => {
  const diffs: Array<FieldDiff> = []
  const cmp = (field: string, a: string | undefined, b: ReadonlyArray<string | undefined>, same = (x: string, y: string) => x === y) => {
    const known = b.filter((v) => v !== undefined)
    if (a === undefined) return
    if (known.length === 0) diffs.push({ field, claimed: a })
    else if (!known.some((v) => same(a, v))) diffs.push({ field, claimed: a, registry: known[0]! })
  }
  cmp("title", claimed.title && plain(claimed.title), [plain(registry.title)], (a, b) => Exit.isSuccess(Effect.runSyncExit(checkTitle(a, b))))
  // The issue year or the online-first year.
  cmp("year", num(claimed.issued && year(claimed as Csl)), years(registry).map(num))
  cmp("author", firstFamily(claimed), [firstFamily(registry)], (a, b) => normalizeTitle(a) === normalizeTitle(b))
  // arXiv's registry record has no journal. The usual ways of writing one for a preprint, including
  // the one `export --format bibtex` prints, are conventions rather than claims.
  const arxiv = registry["container-title"] ? undefined : arxivId(registry)
  const preprint = arxiv ? ["arXiv", "arXiv preprint", `arXiv preprint arXiv:${arxiv}`, "arXiv e-prints", "CoRR"] : []
  const journal = claimed["container-title"]
  cmp("journal", journal && preprint.some((p) => sameJournal(journal, p)) ? undefined : journal, [registry["container-title"], registry["container-title-short"]], sameJournal)
  // DBLP writes arXiv papers as journal CoRR, volume abs/<id>.
  cmp("volume", arxiv && /^abs\//i.test(claimed.volume ?? "") ? undefined : num(claimed.volume), [num(registry.volume)])
  cmp("issue", num(claimed.issue), [num(registry.issue)])
  cmp("page", firstPage(claimed.page), [firstPage(registry.page)])
  return diffs
}

/** The entry's own fields a reference needs, missing ones listed. */
export const missingFields = (e: Partial<Csl>) =>
  [!e.title && "title", !e.author?.length && "author", year(e as Csl) === undefined && "year"].filter((f) => f !== false)

/** MISMATCH over CHECK over OK; details list every finding. */
export const judgeEntry = (e: Partial<Csl>, registry: Csl): { status: Status; details: string } => {
  const diffs = compareEntry(e, registry)
  const missing = missingFields(e)
  const parts = [
    ...diffs.filter((d) => d.registry !== undefined).map((d) => `${d.field}: "${d.claimed}" vs registry "${d.registry}"`),
    ...diffs.filter((d) => d.registry === undefined).map((d) => `${d.field}: "${d.claimed}" not in the registry record`),
    ...(missing.length ? [`entry lacks ${missing.join(", ")}`] : [])
  ]
  const status = diffs.some((d) => d.registry !== undefined) ? "MISMATCH" : parts.length ? "CHECK" : "OK"
  return { status, details: status === "OK" ? plain(registry.title) : parts.join("; ") }
}

/** The identifier a .bib entry carries: DOI, else PMID, else an arXiv id from eprint/url/journal text in its raw block. */
export const bibIdentifier = (e: BibEntry, raw: string): string | undefined => {
  if (e.DOI) return `doi:${e.DOI.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`
  if (e.PMID) return `pmid:${e.PMID}`
  const arxiv = /arxiv\.org\/abs\/([\w./-]+?)(?:v\d+)?(?=[\s}",]|$)/i.exec(raw)?.[1]
    ?? /\barXiv:\s*([\w./-]+?)(?:v\d+)?(?=[\s}",]|$)/i.exec(raw)?.[1]
    ?? (/arxiv/i.test(raw) ? /\beprint\s*=\s*[{"]\s*([^}"\s]+?)(?:v\d+)?\s*[}"]/i.exec(raw)?.[1] : undefined)
  return arxiv ? `arxiv:${arxiv}` : undefined
}

/** Raw text of each `@type{key, …}` entry by key (citation-js drops eprint fields). */
const rawBlocks = (text: string) =>
  new Map(text.split(/^(?=\s*@)/m).flatMap((b) => {
    const key = /^\s*@\w+\s*[{(]\s*([^,\s]+)\s*,/.exec(b)?.[1]
    return key ? [[key, b] as const] : []
  }))

// ---------- resolution (store first, then registry) ----------

const resolve = (id: string) =>
  findItem(id).pipe(
    // A stored item is compared with its overrides applied.
    Effect.map(effective),
    Effect.catchTag("IdentifierNotFoundError", () => parseId(id).pipe(Effect.flatMap(fetchCsl), Effect.map((f) => f.canonical)))
  )

/** NOT_FOUND / ERROR, or the registry record. */
const lookup = (id: string, location: string, record = resolve(id)) =>
  record.pipe(
    Effect.map((csl) => ({ csl })),
    Effect.catch((e) =>
      Effect.succeed({
        finding: { status: e._tag === "IdentifierNotFoundError" ? "NOT_FOUND" : "ERROR", location, id, details: e.message } as Finding
      })
    )
  )

const verifyBibEntry = Effect.fn("verifyBibEntry")(function*(e: BibEntry, raw: string) {
  const location = e["citation-key"] ?? e.id ?? "?"
  const id = bibIdentifier(e, raw)
  if (id === undefined) {
    if (!e.title) return { status: "UNIDENTIFIED", location, details: "no identifier and no title" } as Finding
    const details = yield* findCandidates(e.title, { rows: 5 }).pipe(
      Effect.map((cs) => {
        const best = cs[0]
        return best && best.similarity >= TITLE_FUZZY_THRESHOLD && best.doi
          ? `no identifier; best title match doi:${best.doi} (similarity ${best.similarity}): ${best.title}`
          : "no identifier; no title match found"
      }),
      Effect.catch((err) => Effect.succeed(`no identifier; title search failed: ${err.message}`))
    )
    return { status: "UNIDENTIFIED", location, details } as Finding
  }
  const r = yield* lookup(id, location)
  if ("finding" in r) return r.finding
  return { location, id, ...judgeEntry(e, r.csl) } as Finding
})

const verifyText = Effect.fnUntraced(function*(text: string) {
  const found = extractIds(text)
  // One lookup per identifier, however many contexts cite it.
  const records = new Map<string, ReturnType<typeof resolve>>()
  for (const f of found) if (!records.has(f.key)) records.set(f.key, yield* Effect.cached(resolve(f.id)))
  const looked = yield* Effect.forEach(found, (f) => lookup(f.id, `line ${f.line}`, records.get(f.key)!), { concurrency: 3 })
  // Identifiers in a row for the same work (a DOI, then its PMID) share the text before the first.
  let prev: { start: number; work: string; near: string } | undefined
  const checked = found.map((f, i): Finding => {
    const r = looked[i]!
    if ("finding" in r) {
      prev = undefined
      return r.finding
    }
    const work = itemKey(r.csl, f.key)
    const near = prev && prev.start === f.start && prev.work === work ? `${prev.near} ${f.near}` : f.near
    prev = { start: f.start, work, near }
    const evidence = textEvidence(r.csl, near)
    // A title means a reference entry rather than an in-text citation, so its details must be there too.
    // A table row (as `export --format dossier` prints) is a summary, not a reference entry.
    const missing = evidence?.includes("title found") && !f.context.trimStart().startsWith("|") ? missingDetails(r.csl, near) : []
    if (evidence && missing.length) {
      return { status: "CHECK", location: `line ${f.line}`, id: f.id, details: `${evidence}, but the entry lacks the registry's ${missing.join(", ")}: ${plain(r.csl.title)}` }
    }
    return evidence
      ? { status: "OK", location: `line ${f.line}`, id: f.id, details: `${evidence}: ${plain(r.csl.title)}` }
      : {
        status: "CHECK",
        location: `line ${f.line}`,
        id: f.id,
        details: `neither the title nor first author and year found nearby; registry has "${plain(r.csl.title)}", ${firstFamily(r.csl) ?? "no author"}, ${year(r.csl) ?? "no year"}`
      }
  })
  // In line order; findings on one line keep their reading order.
  const unidentified = unidentifiedItems(text, found)
  return [...checked.map((f, i) => [found[i]!.line, f] as const), ...unidentified.map((u) => [u.line, u.finding] as const)]
    .sort((a, b) => a[0] - b[0])
    .map(([, f]) => f)
})

/**
 * List items with no identifier, in a block of consecutive list items (blank lines between items allowed,
 * any other paragraph ends the block) where most items have one: likely references nobody can check.
 */
export const unidentifiedItems = (text: string, found: ReadonlyArray<Found>) => {
  const lines = text.split("\n")
  const withId = new Set(found.map((f) => f.start))
  const blocks: Array<Array<number>> = [[]]
  let inItem = false
  lines.forEach((l, i) => {
    if (LIST_MARKER.test(l)) {
      blocks.at(-1)!.push(i)
      inItem = true
    } else if (l.trim() === "") inItem = false
    else if (!inItem && blocks.at(-1)!.length) blocks.push([])
  })
  return blocks
    .filter((b) => b.filter((i) => withId.has(i)).length * 2 > b.length)
    .flatMap((b) => b.filter((i) => !withId.has(i)))
    .map((i) => {
      const excerpt = lines[i]!.replace(LIST_MARKER, "").trim()
      return {
        line: i + 1,
        finding: {
          status: "UNIDENTIFIED",
          location: `line ${i + 1}`,
          details: `no identifier: ${excerpt.length > 60 ? `${excerpt.slice(0, 60)}…` : excerpt}`
        } as Finding
      }
    })
}

/**
 * Numbered citations against the numbered reference list: one `CHECK` per problem, one `OK` line
 * when the numbering is clean, and nothing when the text has no such list or no `[n]` markers.
 */
export const numberingFindings = (text: string): Array<Finding> => {
  const n = checkNumbering(text)
  if (n.status !== "checked") return []
  return n.findings.length
    ? n.findings.map((f) => ({ status: "CHECK", location: `line ${f.line}`, details: `numbering: ${f.message}` }))
    : [{ status: "OK", location: "numbering", details: n.message }]
}

export const verifyFile = Effect.fn("verifyFile")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const lower = path.toLowerCase()
  // The input file is the user's argument, not the store: a usage error.
  const unreadable = (e: { message: string }) => usage(`cannot read ${path}: ${e.message}`)
  // A Word file is read as one line per paragraph, so "line N" is paragraph N.
  const text = lower.endsWith(".docx")
    ? yield* fs.readFile(path).pipe(
      Effect.mapError(unreadable),
      Effect.flatMap((bytes) => Effect.try({ try: () => docxText(bytes), catch: (e) => usage(`${path}: ${e instanceof Error ? e.message : String(e)}`) }))
    )
    : yield* fs.readFileString(path).pipe(Effect.mapError(unreadable))
  if (!lower.endsWith(".bib")) return [...yield* verifyText(text), ...numberingFindings(text)]
  if (text.replace(/^\s*%.*$/gm, "").trim() === "") return []
  const { Cite } = yield* Effect.promise(citeLib)
  const entries = yield* Effect.try({
    try: () => new Cite(text).data as Array<BibEntry>,
    catch: (e) => usage(`${path}: cannot parse as BibTeX: ${e instanceof Error ? e.message : String(e)}`)
  })
  const blocks = rawBlocks(text)
  return yield* Effect.forEach(entries, (e) => verifyBibEntry(e, blocks.get(e["citation-key"] ?? "") ?? ""), { concurrency: 3 })
})
