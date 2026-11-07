import { Console, Effect, FileSystem, Path } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import gb7714 from "../styles/gb7714.csl" with { type: "text" }
import gb7714New from "../styles/gb7714-2025.csl" with { type: "text" }
import nature from "../styles/nature.csl" with { type: "text" }
import zhLocale from "../styles/locales-zh-CN.xml" with { type: "text" }
import { decodeEntities } from "./clean.ts"
import { readCollection } from "./collections.ts"
import { httpFailure, normalizeTitle, TIMEOUT_SECONDS, VERSION } from "./resolve.ts"
import { type Csl, CollectionError, isManual, type Item, UpstreamError } from "./schema.ts"
import { authorName, effective, fail, listItems, manualId, plain, readItems, storeDir, year } from "./store.ts"
import { evidenceText, usage } from "./ui.ts"

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

/** Built-in name -> citation-js template. Everything else about a style is read from its CSL. */
export const STYLES = {
  apa: "apa",
  vancouver: "vancouver",
  harvard: "harvard1",
  nature: "nature",
  gb7714: "gb7714",
  "gb7714-2025": "gb7714-2025"
} as const
export type Style = keyof typeof STYLES
/** A style from a file or the CSL repository: the name it is registered under and its (independent) XML. */
export type CslStyle = { name: string; xml: string }

export const FORMATS = ["md", "text", "html", "rtf", "bibtex", "csl-json", "dossier"] as const
export type Format = (typeof FORMATS)[number]
export type ListFormat = "md" | "text" | "html" | "rtf"
export const isList = (f: Format): f is ListFormat => f === "md" || f === "text" || f === "html" || f === "rtf"

/** `<category citation-format="numeric"/>`: numbered by position in collection order. */
export const isNumeric = (xml: string) => /<category\b[^>]*\bcitation-format="numeric"/.test(xml)
const defaultLocale = (xml: string) => /<style\b[^>]*\bdefault-locale="([^"]+)"/.exec(xml)?.[1]
/** The parent's name in a dependent style's `<link rel="independent-parent" href=".../styles/<name>"/>`. */
export const parentOf = (xml: string) => {
  const link = xml.match(/<link\b[^>]*>/g)?.find((l) => /\brel="independent-parent"/.test(l))
  return link && /\bhref="https?:\/\/www\.zotero\.org\/styles\/([^"]+)"/.exec(link)?.[1]
}

// ---------- fetching styles and locales from the CSL repositories, cached in <store>/styles ----------

export const STYLE_NAME = /^[a-z0-9][a-z0-9-]*$/
const REPO = "https://raw.githubusercontent.com/citation-style-language"
const isCsl = (text: string) => text.includes("http://purl.org/net/xbiblio/csl")

/** The body of `url`, undefined on 404. */
const download = Effect.fn("download")(function*(url: string) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeaders({ "User-Agent": `ibid/${VERSION}` }))
  )
  const upstream = (message: string) => new UpstreamError({ url, message })
  const res = yield* Effect.gen(function*() {
    const r = yield* client.get(url)
    return { status: r.status, text: r.status === 200 ? yield* r.text : "" }
  }).pipe(
    Effect.timeout(`${TIMEOUT_SECONDS} seconds`),
    Effect.mapError((e) => upstream(httpFailure(e).message))
  )
  if (res.status === 404) return undefined
  if (res.status !== 200) return yield* upstream(`HTTP ${res.status}`)
  return isCsl(res.text) ? res.text : yield* upstream("not a CSL file")
})

/** `<store>/styles/<file>` when cached, else the first of `urls` that exists, written to the cache. Undefined when none does. */
const cached = Effect.fn("cached")(function*(file: string, urls: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* storeDir("styles")
  const path = (yield* Path.Path).join(dir, file)
  if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) {
    return yield* fs.readFileString(path).pipe(Effect.mapError(fail(path, "cannot read")))
  }
  for (const url of urls) {
    const text = yield* download(url)
    if (text === undefined) continue
    const tmp = `${path}.${process.pid}.tmp`
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(tmp, text)),
      Effect.andThen(fs.rename(tmp, path)),
      Effect.mapError(fail(path, "cannot write"))
    )
    return text
  }
  return undefined
})

/** A repository style's XML from the cache or the first of `dirs` that has it. */
const repoXml = Effect.fn("repoXml")(function*(name: string, dirs: ReadonlyArray<string>, missing: string) {
  if (!STYLE_NAME.test(name)) return yield* usage(`style "${name}": not a built-in style or a .csl path, and not a valid repository name (a-z, 0-9, -)`)
  const xml = yield* cached(`${name}.csl`, dirs.map((d) => `${REPO}/styles/master/${d}${name}.csl`)).pipe(
    Effect.mapError((e) =>
      e._tag === "UpstreamError" ? new UpstreamError({ url: e.url, message: `style ${name}: cannot fetch from the CSL repository (${e.message}) and no cached copy` }) : e
    )
  )
  return xml ?? (yield* usage(missing))
})

/** A dependent style is rendered with its independent parent (a top-level repository style). */
const withParent = Effect.fn("withParent")(function*(name: string, xml: string) {
  const parent = parentOf(xml)
  if (parent === undefined) return { name, xml }
  return { name: parent, xml: yield* repoXml(parent, [""], `style ${name}: parent style ${parent} not found`) }
})

const repoStyle = Effect.fn("repoStyle")(function*(name: string) {
  const xml = yield* repoXml(name, ["", "dependent/"], `style ${name}: not a built-in style, a .csl file or a style in the CSL repository`)
  return yield* withParent(name, xml)
})

/** Registers a locale the style needs from the cache or the repository; on failure the list renders in en-US. */
const loadLocale = Effect.fn("loadLocale")(function*(lang: string) {
  const registry = (yield* Effect.promise(citeLib)).plugins.config.get("@csl")
  if (registry.locales.has(lang)) return
  const note = (why: string) => Console.error(`note: locale ${lang} ${why}; rendering in en-US`)
  if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(lang)) return yield* note("is not a locale file name")
  const xml = yield* cached(`locales-${lang}.xml`, [`${REPO}/locales/master/locales-${lang}.xml`]).pipe(
    Effect.catch((e) => note(`unavailable (${e.message})`).pipe(Effect.as(null)))
  )
  if (xml === undefined) return yield* note("not found in the CSL repository")
  if (xml !== null) registry.locales.add(lang, xml)
})

/** `--style`: a built-in name, a path to a `.csl` file, or a CSL repository name (fetched once, then cached). */
export const resolveStyle = Effect.fn("resolveStyle")(function*(input: string) {
  if (input in STYLES) return input as Style
  let style: CslStyle
  if (input.endsWith(".csl")) {
    const path = (yield* Path.Path).resolve(input)
    const xml = yield* (yield* FileSystem.FileSystem).readFileString(path).pipe(Effect.mapError(fail(path, "cannot read")))
    if (!isCsl(xml)) return yield* usage(`${path}: not a CSL style`)
    style = yield* withParent(`file:${path}`, xml)
  } else style = yield* repoStyle(input)
  const lang = defaultLocale(style.xml)
  if (lang) yield* loadLocale(lang)
  return style
})

// ---------- rendering ----------

export const isChinese = (c: Csl) => (c.language?.toLowerCase().startsWith("zh") ?? false) || /\p{Script=Han}/u.test(c.title)

/** What citation-js gets: the stored record with an id; a given-name-only author (common for Chinese registries) becomes a literal name. */
const citeData = (c: Csl, id: string) => ({
  ...c,
  id,
  ...(c.author && { author: c.author.map((a) => a.family || a.literal || !a.given ? a : { literal: a.given }) })
})


/** citeproc HTML -> one Markdown line: italics `*`, bold `**`, other tags dropped, entities decoded. */
export const htmlToMd = (html: string) =>
  decodeEntities(
    html
      .replace(/<div class="csl-left-margin">(.*?)<\/div>/g, "$1 ")
      .replace(/<\/?(i|em)>/g, "*")
      .replace(/<\/?(b|strong)>/g, "**")
      .replace(/<[^>]*>/g, "")
  ).replace(/\s+/g, " ").trim()

/** A numeric style numbers each rendered batch from 1; put the entry's position in the full list instead. */
export const renumber = (s: string, n: number) => s.replace(/^(\[?)\d+([.\]])/, `$1${n}$2`)

const HANG = "margin:0 0 0 2em;text-indent:-2em"
const HANG_NUM = "margin:0 0 0 2.5em;text-indent:-2.5em"

/** citeproc HTML -> one `<p>` with a hanging indent; a numeric style's number in a fixed-width box so the text aligns. */
const htmlEntry = (html: string, n?: number) => {
  const inner = html.trim().replace(/^<div[^>]*>|<\/div>$/g, "")
  const margin = /<div class="csl-left-margin">(.*?)<\/div>/s.exec(inner)?.[1]
  const body = (/<div class="csl-right-inline">(.*?)<\/div>/s.exec(inner)?.[1] ?? inner).trim()
  if (n === undefined) return `<p style="${HANG}">${body}</p>`
  if (margin === undefined) return `<p style="${HANG_NUM}">${renumber(body, n)}</p>`
  return `<p style="${HANG_NUM}"><span style="display:inline-block;min-width:2.5em">${renumber(margin.trim(), n)} </span>${body}</p>`
}

/** citeproc RTF (a numeric style's number ends in `\tab`) -> one paragraph with a 0.5 in hanging indent and tab stop. */
const rtfEntry = (rtf: string, n?: number) => `\\pard\\li720\\fi-720\\tx720\\sa120 ${n === undefined ? rtf.trim() : renumber(rtf.trim(), n)}\\par`

const escapeHtml = (s: string) => s.replace(/&/g, "&#38;").replace(/</g, "&#60;").replace(/>/g, "&#62;")

/** RTF control characters escaped, everything beyond ASCII as `\uN` (signed 16-bit, as RTF wants). */
export const escapeRtf = (s: string) =>
  s.replace(/[\\{}]/g, "\\$&").replace(/[^\x00-\x7f]/g, (ch) => {
    const n = ch.charCodeAt(0)
    return `\\uc0\\u${n > 32767 ? n - 65536 : n}{}`
  })

/** The number label of a raw citeproc entry (`1.`, `[1]`), so a manual entry is numbered like its neighbours. */
const labelOf = (raw: string | undefined, format: ListFormat) => {
  const label = raw === undefined
    ? undefined
    : format === "rtf"
    ? /^(.*?)\\tab/.exec(raw.trim())?.[1]
    : format === "text"
    ? /^\S+/.exec(raw.trim())?.[0]
    : /<div class="csl-left-margin">(.*?)<\/div>/s.exec(raw)?.[1]?.trim()
  return label ?? "1."
}

/** A manual entry as a raw citeproc entry of `format`: the text as written, after the number label in a numeric style. */
const manualEntry = (text: string, format: ListFormat, label?: string) => {
  if (format === "text") return label ? `${label} ${text}` : text
  if (format === "rtf") return label ? `${label}\\tab ${escapeRtf(text)}` : escapeRtf(text)
  return label
    ? `<div class="csl-entry"><div class="csl-left-margin">${label}</div><div class="csl-right-inline">${escapeHtml(text)}</div></div>`
    : `<div class="csl-entry">${escapeHtml(text)}</div>`
}

/** The XML of a built-in or loaded style. */
export const styleXml = async (style: Style | CslStyle) =>
  typeof style === "string" ? (await citeLib()).plugins.config.get("@csl").styles.get(STYLES[style]) as string : style.xml

/**
 * One rendered entry per item, in list order; `html` and `rtf` entries are paragraphs for `render` to wrap.
 * A string is a manual entry: printed as written, numbered like the rest in a numeric style, and
 * placed last when the style sorts.
 *
 * Numeric styles keep the given order and are numbered by position. Other styles follow the
 * style's own sort, unless `keepOrder`. Each locale group is rendered in one batch, so citeproc
 * sees the whole group (APA/Harvard `2020a`/`2020b`). A style whose default locale is Chinese
 * renders Chinese entries in it and others in en-US, as separate batches (rendered together,
 * English entries get `等` instead of `et al.`); when sorted, the Chinese group comes first.
 * Other styles render everything in their default locale when it is loaded, else en-US.
 */
export const renderList = async (list: ReadonlyArray<Csl | string>, style: Style | CslStyle, format: ListFormat, keepOrder = false) => {
  const { Cite, plugins } = await citeLib()
  const registry = plugins.config.get("@csl")
  const name = typeof style === "string" ? STYLES[style] : style.name
  const xml = await styleXml(style)
  if (typeof style !== "string") registry.styles.add(name, xml)
  // Registry records render through citeproc; manual entries are kept by position (`r<i>`).
  const csls = list.map((c) => typeof c === "string" ? undefined : c)
  const numeric = isNumeric(xml)
  const sorted = !numeric && !keepOrder
  const def = defaultLocale(xml)
  const main = def && registry.locales.has(def) ? def : "en-US"
  // Only a Chinese style is bilingual. Elsewhere the zh-CN locale would leak
  // Chinese terms into the entry (`2011年`, `页 1. 载于:`).
  const lang = (c: Csl) => def?.startsWith("zh") && !isChinese(c) ? "en-US" : main
  const groups = [...new Set(csls.flatMap((c) => c ? [lang(c)] : []))]
  if (sorted) groups.sort((a, b) => Number(b === main) - Number(a === main))
  const entries = new Map<string, string>()
  for (const group of groups) {
    const data = csls.flatMap((c, i) => {
      if (!c || lang(c) !== group) return []
      // With a DOI, the registry's URL is just the resolver or a landing page, and GB/T prints both.
      const { URL: _url, ...noUrl } = c
      return [citeData(c.DOI ? noUrl : c, `r${i}`)]
    })
    const out = new Cite(data).format("bibliography", {
      format: format === "md" ? "html" : format,
      template: name,
      lang: group,
      nosort: !sorted,
      asEntryArray: true
    }) as unknown as Array<[string, string]>
    for (const [id, entry] of out) entries.set(id, entry)
  }
  const label = numeric ? labelOf(entries.values().next().value, format) : undefined
  // After the sorted registry entries, so a sorting style lists manual entries last.
  list.forEach((c, i) => {
    if (typeof c === "string") entries.set(`r${i}`, manualEntry(c, format, label))
  })
  const ids = sorted ? [...entries.keys()] : list.map((_, i) => `r${i}`)
  return ids.map((id, i) => {
    const entry = entries.get(id) ?? ""
    const n = numeric ? i + 1 : undefined
    if (format === "html") return htmlEntry(entry, n)
    if (format === "rtf") return rtfEntry(entry, n)
    const line = format === "md" ? htmlToMd(entry) : entry.replace(/\s+/g, " ").trim()
    return n === undefined ? line : renumber(line, n)
  })
}

/** A self-contained HTML fragment; pasted into Word or Docs it keeps italics, bold, super/subscript and the indent. */
const htmlList = (entries: ReadonlyArray<string>) => `<meta charset="utf-8">\n<div class="csl-bib-body">\n${entries.join("\n")}\n</div>`

/** A complete RTF document; non-ASCII is already `\uN` escaped by citeproc. Piped to `pbcopy` it becomes rich text. */
const rtfList = (entries: ReadonlyArray<string>) => `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\froman Times New Roman;}}\\f0\n${entries.join("\n")}\n}`

const ascii = (s: string) => s.normalize("NFKD").replace(/[^A-Za-z0-9]/g, "")

/** Six hex digits that depend only on the item: its DOI, else PMID, else title. */
export const shortHash = (c: Csl) =>
  new Bun.CryptoHasher("sha256").update(c.DOI?.toLowerCase() ?? (c.PMID ? `pmid:${c.PMID}` : plain(c.title))).digest("hex").slice(0, 6)

/**
 * `<family><year><first title word>` in ASCII. When the name has no Latin letters, or two entries
 * would share a key, `ref<year>` / that key plus `shortHash`: disambiguation depends on the entry
 * itself rather than its position, though adding or removing a colliding entry changes both keys.
 */
export const citationKeys = (csls: ReadonlyArray<Csl>) => {
  const bases = csls.map((c) => {
    const a = c.author?.[0]
    const name = ascii(a ? a.family ?? a.literal ?? a.given ?? "" : "").toLowerCase()
    const word = normalizeTitle(plain(c.title)).split(" ").map(ascii).find((w) => w.length > 3)?.toLowerCase() ?? ""
    return name ? `${name}${year(c) ?? ""}${word}` : `ref${year(c) ?? ""}${shortHash(c)}`
  })
  const count = new Map<string, number>()
  for (const b of bases) count.set(b, (count.get(b) ?? 0) + 1)
  const used = new Set<string>()
  return bases.map((base, i) => {
    const first = count.get(base)! > 1 && !base.endsWith(shortHash(csls[i]!)) ? `${base}${shortHash(csls[i]!)}` : base
    // Still taken only when the same item is listed twice.
    let key = first
    for (let n = 2; used.has(key); n++) key = `${first}_${n}`
    used.add(key)
    return key
  })
}

/** arXiv's DataCite records have no container; BibTeX wants a journal for `@article`. */
const arxivJournal = (c: Csl) => {
  const id = arxivId(c)
  return id && !c["container-title"] ? { "container-title": `arXiv preprint arXiv:${id}` } : {}
}

/** The arXiv id of a record registered under arXiv's DataCite prefix. */
export const arxivId = (c: Csl) => /^10\.48550\/arxiv\.(.+)$/i.exec(c.DOI ?? "")?.[1]

const escapeBibtex = (s: string) => s.replace(/\\/g, "\\textbackslash{}").replace(/[{}%&#_$]/g, "\\$&")

/** A manual entry as `@misc` with the text in `note`; the key is its id without the colon. */
const manualBibtex = (text: string) => `@misc{${manualId(text).replace(":", "")},\n\tnote = {${escapeBibtex(text)}}\n}`

/** Registry records through citation-js, manual entries as `@misc`, in list order. */
export const renderBibtex = async (list: ReadonlyArray<Csl | string>) => {
  const { Cite } = await citeLib()
  const csls = list.filter((c) => typeof c !== "string")
  const keys = citationKeys(csls)
  const out = csls.length
    ? (new Cite(csls.map((c, i) => ({ ...citeData(c, keys[i]!), ...arxivJournal(c), "citation-key": keys[i] }))).format("bibtex") as string).trim()
    : ""
  const rendered = out ? out.split(/\n\s*(?=@)/) : []
  return list.map((c) => typeof c === "string" ? manualBibtex(c) : rendered.shift()!.trim()).join("\n\n")
}

// ---------- dossier ----------

export type Row = { item: Item; context?: string; section?: string }

const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim()

export const linkOf = (c: Csl) =>
  c.DOI ? `https://doi.org/${c.DOI}` : c.PMID ? `https://pubmed.ncbi.nlm.nih.gov/${c.PMID}/` : c.URL ?? ""

/** Markdown table: number, author and year, title, notes (section, context, note texts), link. */
export const dossier = (rows: ReadonlyArray<Row>) => {
  const lines = rows.map(({ context, item, section }, i) => {
    const c = effective(item)
    const a = c.author?.[0]
    const who = isManual(item)
      ? "(manual entry)"
      : a
      ? `${a.family ?? a.literal ?? a.given}${(c.author?.length ?? 0) > 1 ? (isChinese(c) ? " 等" : " et al.") : ""}, ${year(c) ?? "n.d."}`
      : `-, ${year(c) ?? "n.d."}`
    const notes = [
      section && `section: ${section}`,
      context && `context: ${context}`,
      ...item.evidences.filter((e) => typeof e === "object" && e !== null && "text" in e).map(evidenceText)
    ].filter(Boolean).join("; ")
    const link = linkOf(c)
    return `| ${i + 1} | ${cell(who)} | ${cell(plain(c.title))} | ${cell(notes)} | ${link ? `[${cell(c.DOI ? `doi:${c.DOI}` : c.PMID ? `PMID ${c.PMID}` : "link")}](${link})` : ""} |`
  })
  return ["| # | Author, year | Title | Notes | Link |", "| --- | --- | --- | --- | --- |", ...lines].join("\n")
}

// ---------- export ----------

/** A collection's entries in order (a missing item is an error), else every item by first author, then year, manual entries last. */
export const exportRows = Effect.fn("exportRows")(function*(name: string | undefined) {
  if (name === undefined) {
    const key = (i: Item) => {
      const a = effective(i).author?.[0]
      return (a ? authorName(a) : "").toLowerCase()
    }
    return [...yield* listItems()]
      .sort((a, b) =>
        Number(isManual(a)) - Number(isManual(b)) || key(a).localeCompare(key(b)) || (year(effective(a)) ?? 0) - (year(effective(b)) ?? 0)
      )
      .map((item): Row => ({ item }))
  }
  const col = yield* readCollection(name)
  const byId = yield* readItems(col.entries.map((e) => e.itemId))
  return yield* Effect.forEach(col.entries, (e, i) => {
    const item = byId.get(e.itemId)
    return item
      ? Effect.succeed<Row>({ item, ...(e.context !== undefined && { context: e.context }), ...(e.section !== undefined && { section: e.section }) })
      : Effect.fail(new CollectionError({ name, message: `${name}: entry [${i + 1}] ${e.itemId} is not in the store (re-add it or remove the entry)` }))
  })
})

/** Every format renders the effective record (overrides applied); a manual entry is its text. */
export const render = (rows: ReadonlyArray<Row>, format: Format, style: Style | CslStyle, keepOrder = false): Promise<string> => {
  const csls = rows.map(({ item }) => isManual(item) ? item.manual : effective(item))
  switch (format) {
    case "md":
    case "text":
      return renderList(csls, style, format, keepOrder).then((ls) => ls.join("\n"))
    case "html":
      return renderList(csls, style, format, keepOrder).then(htmlList)
    case "rtf":
      return renderList(csls, style, format, keepOrder).then(rtfList)
    case "bibtex":
      return renderBibtex(csls)
    case "csl-json":
      // A manual entry is marked in CSL's `custom` object; its title is the reference text as written.
      return Promise.resolve(JSON.stringify(
        rows.map(({ item }) => ({ id: item.id, ...effective(item), ...(isManual(item) && { custom: { "ibid-manual": true } }) })),
        null,
        2
      ))
    case "dossier":
      return Promise.resolve(dossier(rows))
  }
}
