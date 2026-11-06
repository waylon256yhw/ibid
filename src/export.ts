import { Effect } from "effect"
import gb7714 from "../styles/gb7714.csl" with { type: "text" }
import gb7714New from "../styles/gb7714-2025.csl" with { type: "text" }
import nature from "../styles/nature.csl" with { type: "text" }
import zhLocale from "../styles/locales-zh-CN.xml" with { type: "text" }
import { readCollection } from "./collections.ts"
import { normalizeTitle } from "./resolve.ts"
import { type Csl, CollectionError, type Item } from "./schema.ts"
import { authorName, listItems, plain, year } from "./store.ts"
import { evidenceText } from "./ui.ts"

// ---------- citation-js, loaded on first use (it adds ~20 ms to every start otherwise) ----------

let lib: Promise<typeof import("@citation-js/core")> | undefined

export const citeLib = () =>
  lib ??= (async () => {
    const core = await import("@citation-js/core")
    await import("@citation-js/plugin-csl")
    await import("@citation-js/plugin-bibtex")
    const csl = core.plugins.config.get("@csl")
    csl.styles.add("nature", nature)
    csl.styles.add("gb7714", gb7714)
    csl.styles.add("gb7714-2025", gb7714New)
    // bun-types declares *.xml as a parsed document; with type "text" it is the raw string.
    csl.locales.add("zh-CN", zhLocale as unknown as string)
    // Without this, BibTeX output drops every non-ASCII character.
    core.plugins.config.get("@bibtex").format.asciiOnly = false
    return core
  })()

// ---------- styles and formats ----------

/** CLI name -> citation-js template; numeric styles print their own `1.` / `[1]`, which we renumber. */
export const STYLES = {
  apa: { template: "apa", numeric: false },
  vancouver: { template: "vancouver", numeric: true },
  harvard: { template: "harvard1", numeric: false },
  nature: { template: "nature", numeric: true },
  gb7714: { template: "gb7714", numeric: true },
  "gb7714-2025": { template: "gb7714-2025", numeric: true }
} as const
export type Style = keyof typeof STYLES

export const FORMATS = ["md", "text", "bibtex", "csl-json", "dossier"] as const
export type Format = (typeof FORMATS)[number]

export const isChinese = (c: Csl) => (c.language?.toLowerCase().startsWith("zh") ?? false) || /\p{Script=Han}/u.test(c.title)

/** What citation-js gets: the stored record with an id; a given-name-only author (common for Chinese registries) becomes a literal name. */
const citeData = (c: Csl, id: string) => ({
  ...c,
  id,
  ...(c.author && { author: c.author.map((a) => a.family || a.literal || !a.given ? a : { literal: a.given }) })
})

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ENTITIES[e.toLowerCase()] ?? m)

/** citeproc HTML -> one Markdown line: italics `*`, bold `**`, other tags dropped, entities decoded. */
export const htmlToMd = (html: string) =>
  decodeEntities(
    html
      .replace(/<div class="csl-left-margin">(.*?)<\/div>/g, "$1 ")
      .replace(/<\/?(i|em)>/g, "*")
      .replace(/<\/?(b|strong)>/g, "**")
      .replace(/<[^>]*>/g, "")
  ).replace(/\s+/g, " ").trim()

/** A numeric style rendered one entry at a time always says `1`; put the real number back. */
export const renumber = (s: string, n: number) => s.replace(/^(\[?)1([.\]])/, `$1${n}$2`)

/**
 * One line per entry, in the given order. Each entry is rendered on its own so it gets its own
 * locale: rendered together, GB/T 7714 gives English entries `等` instead of `et al.`.
 */
export const renderList = async (csls: ReadonlyArray<Csl>, style: Style, format: "md" | "text") => {
  const { Cite } = await citeLib()
  const { numeric, template } = STYLES[style]
  // Only the GB/T styles are bilingual. In an English style the zh-CN locale would leak
  // Chinese terms into the entry (`2011年`, `页 1. 载于:`).
  const bilingual = template.startsWith("gb7714")
  return csls.map((c, i) => {
    // With a DOI, the registry's URL is just the resolver or a landing page, and GB/T prints both.
    const { URL: _url, ...noUrl } = c
    const out = new Cite([citeData(c.DOI ? noUrl : c, `r${i}`)]).format("bibliography", {
      format: format === "md" ? "html" : "text",
      template,
      lang: bilingual && isChinese(c) ? "zh-CN" : "en-US",
      nosort: true
    }) as string
    const line = format === "md" ? htmlToMd(out) : out.replace(/\s+/g, " ").trim()
    return numeric ? renumber(line, i + 1) : line
  })
}

const ascii = (s: string) => s.normalize("NFKD").replace(/[^A-Za-z0-9]/g, "")

/** `<family><year><first title word>` in ASCII (`ref` when the name has no Latin letters), made unique with b, c, … */
export const citationKeys = (csls: ReadonlyArray<Csl>) => {
  const used = new Set<string>()
  return csls.map((c) => {
    const a = c.author?.[0]
    const name = ascii(a ? a.family ?? a.literal ?? a.given ?? "" : "").toLowerCase() || "ref"
    const word = normalizeTitle(plain(c.title)).split(" ").map(ascii).find((w) => w.length > 3)?.toLowerCase() ?? ""
    const base = `${name}${year(c) ?? ""}${word}`
    let key = base
    for (let i = 1; used.has(key); i++) key = `${base}${"bcdefghijklmnopqrstuvwxyz"[i - 1] ?? i}`
    used.add(key)
    return key
  })
}

export const renderBibtex = async (csls: ReadonlyArray<Csl>) => {
  const { Cite } = await citeLib()
  const keys = citationKeys(csls)
  return (new Cite(csls.map((c, i) => ({ ...citeData(c, keys[i]!), "citation-key": keys[i] }))).format("bibtex") as string).trim()
}

// ---------- dossier ----------

export type Row = { item: Item; context?: string; section?: string }

const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim()

export const linkOf = (c: Csl) =>
  c.DOI ? `https://doi.org/${c.DOI}` : c.PMID ? `https://pubmed.ncbi.nlm.nih.gov/${c.PMID}/` : c.URL ?? ""

/** Markdown table: number, author and year, title, notes (section, context, note texts), link. */
export const dossier = (rows: ReadonlyArray<Row>) => {
  const lines = rows.map(({ context, item, section }, i) => {
    const c = item.canonical
    const a = c.author?.[0]
    const who = a ? `${a.family ?? a.literal ?? a.given}${(c.author?.length ?? 0) > 1 ? (isChinese(c) ? " 等" : " et al.") : ""}` : "-"
    const notes = [
      section && `section: ${section}`,
      context && `context: ${context}`,
      ...item.evidences.filter((e) => typeof e === "object" && e !== null && "text" in e).map(evidenceText)
    ].filter(Boolean).join("; ")
    const link = linkOf(c)
    return `| ${i + 1} | ${cell(`${who}, ${year(c) ?? "n.d."}`)} | ${cell(plain(c.title))} | ${cell(notes)} | ${link ? `[${cell(c.DOI ? `doi:${c.DOI}` : c.PMID ? `PMID ${c.PMID}` : "link")}](${link})` : ""} |`
  })
  return ["| # | Author, year | Title | Notes | Link |", "| --- | --- | --- | --- | --- |", ...lines].join("\n")
}

// ---------- export ----------

/** A collection's entries in order (a missing item is an error), else every item by first author, then year. */
export const exportRows = Effect.fn("exportRows")(function*(name: string | undefined) {
  const items = yield* listItems()
  if (name === undefined) {
    const key = (i: Item) => (i.canonical.author?.[0] ? authorName(i.canonical.author[0]) : "").toLowerCase()
    return [...items]
      .sort((a, b) => key(a).localeCompare(key(b)) || (year(a.canonical) ?? 0) - (year(b.canonical) ?? 0))
      .map((item): Row => ({ item }))
  }
  const col = yield* readCollection(name)
  const byId = new Map(items.map((i) => [i.id, i]))
  return yield* Effect.forEach(col.entries, (e, i) => {
    const item = byId.get(e.itemId)
    return item
      ? Effect.succeed<Row>({ item, ...(e.context !== undefined && { context: e.context }), ...(e.section !== undefined && { section: e.section }) })
      : Effect.fail(new CollectionError({ name, message: `${name}: entry [${i + 1}] ${e.itemId} is not in the store (re-add it or remove the entry)` }))
  })
})

export const render = (rows: ReadonlyArray<Row>, format: Format, style: Style): Promise<string> => {
  const csls = rows.map((r) => r.item.canonical)
  switch (format) {
    case "md":
    case "text":
      return renderList(csls, style, format).then((ls) => ls.join("\n"))
    case "bibtex":
      return renderBibtex(csls)
    case "csl-json":
      return Promise.resolve(JSON.stringify(rows.map(({ item }) => ({ id: item.id, ...item.canonical })), null, 2))
    case "dossier":
      return Promise.resolve(dossier(rows))
  }
}
