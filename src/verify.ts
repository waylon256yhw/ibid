import { Effect, Exit, FileSystem } from "effect"
import { citeLib } from "./export.ts"
import { findCandidates } from "./find.ts"
import { checkTitle, fetchCsl, normalizeTitle, parseId, TITLE_FUZZY_THRESHOLD } from "./resolve.ts"
import type { Csl } from "./schema.ts"
import { fail, findItem, keyOf, plain, year } from "./store.ts"
import { usage } from "./ui.ts"

export type Status = "OK" | "MISMATCH" | "NOT_FOUND" | "UNIDENTIFIED" | "CHECK" | "ERROR"
export type Finding = { status: Status; location: string; id?: string; details: string }

// ---------- identifiers in prose ----------

const CLOSE: Record<string, string> = { ")": "(", "]": "[", "}": "{" }
const count = (s: string, c: string) => s.split(c).length - 1

/** Drops trailing punctuation, and closing brackets that have no opening partner inside the DOI. */
export const trimDoi = (raw: string) => {
  let s = raw
  for (;;) {
    const last = s.at(-1) ?? ""
    if (/[.,;:!?'"*_>]/.test(last)) s = s.slice(0, -1)
    else if (CLOSE[last] && count(s, CLOSE[last]) < count(s, last)) s = s.slice(0, -1)
    else return s
  }
}

export type Found = { id: string; key: string; line: number }

/** Distinct DOIs, `PMID: n` and `arXiv:id` in reading order, each with the line it first appears on. */
export const extractIds = (text: string): Array<Found> => {
  const out: Array<Found> = []
  const seen = new Set<string>()
  text.split("\n").forEach((l, i) => {
    const hits = [
      ...[...l.matchAll(/\b10\.\d{4,9}\/[^\s"<>]+/g)].map((m) => ({ at: m.index, id: `doi:${trimDoi(m[0])}` })),
      ...[...l.matchAll(/\bPMID:?\s*(\d+)\b/gi)].map((m) => ({ at: m.index, id: `pmid:${m[1]}` })),
      ...[...l.matchAll(/\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/gi)].map((m) => ({ at: m.index, id: `arxiv:${m[1]}` }))
    ].sort((a, b) => a.at - b.at)
    for (const { id } of hits) {
      const ref = Effect.runSyncExit(parseId(id))
      if (Exit.isFailure(ref)) continue
      const key = keyOf(ref.value)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id, key, line: i + 1 })
    }
  })
  return out
}

/** The blank-line-separated paragraph that holds 1-based `line`. */
export const paragraphAt = (text: string, line: number) => {
  const lines = text.split("\n")
  let start = line - 1
  let end = line - 1
  while (start > 0 && lines[start - 1]!.trim() !== "") start--
  while (end < lines.length - 1 && lines[end + 1]!.trim() !== "") end++
  return lines.slice(start, end + 1).join("\n")
}

export const titleInText = (title: string, text: string) => ` ${normalizeTitle(text)} `.includes(` ${normalizeTitle(title)} `)

// ---------- .bib entries ----------

type BibEntry = Partial<Csl> & { "citation-key"?: string; id?: string }

const num = (v: unknown) => v === undefined || v === null || String(v).trim() === "" ? undefined : String(v).trim().replace(/^0+(?=\d)/, "")
const firstPage = (p: string | undefined) => num(p?.split(/[-–—,]/)[0])
const firstFamily = (c: Partial<Csl>) => {
  const a = c.author?.[0]
  return a ? a.family ?? a.literal ?? a.given : undefined
}

export type FieldDiff = { field: string; claimed: string; registry: string }

/** Fields present on both sides that disagree: title (the `checkTitle` rule), year, first author family name, volume, issue, first page. */
export const compareEntry = (claimed: Partial<Csl>, registry: Csl): Array<FieldDiff> => {
  const diffs: Array<FieldDiff> = []
  const cmp = (field: string, a: string | undefined, b: string | undefined, same = (x: string, y: string) => x === y) => {
    if (a !== undefined && b !== undefined && !same(a, b)) diffs.push({ field, claimed: a, registry: b })
  }
  cmp("title", claimed.title && plain(claimed.title), plain(registry.title), (a, b) => Exit.isSuccess(Effect.runSyncExit(checkTitle(a, b))))
  cmp("year", num(claimed.issued && year(claimed as Csl)), num(year(registry)))
  cmp("author", firstFamily(claimed), firstFamily(registry), (a, b) => normalizeTitle(a) === normalizeTitle(b))
  cmp("volume", num(claimed.volume), num(registry.volume))
  cmp("issue", num(claimed.issue), num(registry.issue))
  cmp("page", firstPage(claimed.page), firstPage(registry.page))
  return diffs
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
    Effect.map((i) => i.canonical),
    Effect.catchTag("IdentifierNotFoundError", () => parseId(id).pipe(Effect.flatMap(fetchCsl), Effect.map((f) => f.canonical)))
  )

/** NOT_FOUND / ERROR, or the registry record. */
const lookup = (id: string, location: string) =>
  resolve(id).pipe(
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
  const diffs = compareEntry(e, r.csl)
  return diffs.length === 0
    ? { status: "OK", location, id, details: plain(r.csl.title) } as Finding
    : {
      status: "MISMATCH",
      location,
      id,
      details: diffs.map((d) => `${d.field}: "${d.claimed}" vs registry "${d.registry}"`).join("; ")
    } as Finding
})

const verifyText = (text: string) =>
  Effect.forEach(extractIds(text), Effect.fnUntraced(function*({ id, line }) {
    const location = `line ${line}`
    const r = yield* lookup(id, location)
    if ("finding" in r) return r.finding
    const title = plain(r.csl.title)
    return titleInText(title, paragraphAt(text, line))
      ? { status: "OK", location, id, details: title } as Finding
      : { status: "CHECK", location, id, details: `registry title not in the surrounding text: "${title}"` } as Finding
  }), { concurrency: 3 })

export const verifyFile = Effect.fn("verifyFile")(function*(path: string) {
  const text = yield* (yield* FileSystem.FileSystem).readFileString(path).pipe(Effect.mapError(fail(path, "cannot read")))
  if (!path.toLowerCase().endsWith(".bib")) return yield* verifyText(text)
  const { Cite } = yield* Effect.promise(citeLib)
  const entries = yield* Effect.try({
    try: () => new Cite(text).data as Array<BibEntry>,
    catch: (e) => usage(`${path}: cannot parse as BibTeX: ${e instanceof Error ? e.message : String(e)}`)
  })
  const blocks = rawBlocks(text)
  return yield* Effect.forEach(entries, (e) => verifyBibEntry(e, blocks.get(e["citation-key"] ?? "") ?? ""), { concurrency: 3 })
})
