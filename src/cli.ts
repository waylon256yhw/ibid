#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { col } from "./col.ts"
import { deleteItem } from "./collections.ts"
import { exportRows, FORMATS, isList, isNumeric, render, resolveStyle, STYLES, styleXml } from "./export.ts"
import { findCandidates, findLine } from "./find.ts"
import { VERSION } from "./resolve.ts"
import { isManual, type Overrides } from "./schema.ts"
import {
  addManual,
  addNote,
  fail,
  findItem,
  findStore,
  listItems,
  matchesQuery,
  OVERRIDE_FIELDS,
  type OverrideField,
  parseAuthors,
  writeItem
} from "./store.ts"
import {
  checkTitles,
  expectTitle,
  failWith,
  fetchAndStore,
  handle,
  json,
  line,
  overrideItem,
  overrideLines,
  printJson,
  report,
  showLines,
  tryEach,
  usage,
  withWarnings
} from "./ui.ts"
import { verifyFile } from "./verify.ts"

const idArg = Argument.String("id").pipe(Argument.withDescription("doi:…, pmid:…, pmc:…, arxiv:…, 10.x DOI or https://doi.org/ URL"))

const add = Command.make("add", {
  ids: idArg.pipe(Argument.atLeast(0)),
  manual: Flag.String("manual").pipe(
    Flag.withDescription("Store a reference that has no identifier, as written (repeatable); its id is manual:<hash of the text>"),
    Flag.atLeast(0)
  ),
  expectTitle,
  json
}, handle(Effect.fn(function*({ expectTitle, ids, json, manual }) {
  if (ids.length === 0 && manual.length === 0) return yield* usage("give at least one identifier or --manual text")
  const fetched = yield* fetchAndStore(ids, yield* checkTitles(ids, expectTitle))
  const manuals = yield* tryEach(manual, (text) => addManual(text).pipe(Effect.map((item) => ({ item }))))
  yield* report(withWarnings([...fetched, ...manuals]), json, (r) => line(r.item))
}))).pipe(Command.withDescription("Fetch, verify and store items by identifier, or store reference text with --manual"))

const show = Command.make("show", { id: idArg, json }, handle(Effect.fn(function*({ id, json }) {
  const item = yield* findItem(id)
  if (json) return yield* printJson(item)
  for (const l of showLines(item)) yield* Console.log(l)
}))).pipe(Command.withDescription("Show one stored item (with overrides applied, each next to the registry value)"))

const fieldFlag = (name: string, what: string) => Flag.String(name).pipe(Flag.withDescription(what), Flag.optional)

const override = Command.make("override", {
  id: idArg,
  title: fieldFlag("title", "Title"),
  authors: fieldFlag("authors", "\"Family, Given; Family, Given\"; a name without a comma is a group (literal) name"),
  year: Flag.Int("year").pipe(Flag.withDescription("Year"), Flag.optional),
  journal: fieldFlag("journal", "Journal (container title)"),
  volume: fieldFlag("volume", "Volume"),
  issue: fieldFlag("issue", "Issue"),
  page: fieldFlag("page", "Pages or article number"),
  clear: Flag.Literals("clear", Object.keys(OVERRIDE_FIELDS) as Array<OverrideField>).pipe(
    Flag.withDescription("Drop the override of this field (repeatable)"),
    Flag.atLeast(0)
  ),
  clearAll: Flag.Boolean("clear-all").pipe(Flag.withDescription("Drop every override"), Flag.withDefault(false)),
  json
}, handle(Effect.fn(function*({ authors, clear, clearAll, id, issue, journal, json, page, title, volume, year }) {
  const given = { title, journal, volume, issue, page }
  const set: Record<string, unknown> = {}
  for (const [f, v] of Object.entries(given)) {
    if (Option.isNone(v)) continue
    if (!v.value.trim()) return yield* usage(`--${f} must not be empty; use --clear ${f} to drop an override`)
    set[OVERRIDE_FIELDS[f as OverrideField]] = v.value.trim()
  }
  if (Option.isSome(authors)) {
    const list = parseAuthors(authors.value)
    if (list.length === 0) return yield* usage("--authors needs at least one name: \"Family, Given; Family, Given\"")
    set.author = list
  }
  if (Option.isSome(year)) {
    if (year.value < 1) return yield* usage("--year must be a positive year")
    set.issued = { "date-parts": [[year.value]] }
  }
  const saved = yield* overrideItem(id, set as Overrides, clear, clearAll)
  if (json) return yield* printJson(saved)
  yield* Console.log(line(saved))
  for (const l of overrideLines(saved)) yield* Console.log(l)
  if (!saved.overrides) yield* Console.log("  no overrides")
}))).pipe(Command.withDescription("Correct fields of a stored record locally; the registry record is kept and shown beside it"))

const ls = Command.make("ls", {
  query: Argument.String("query").pipe(Argument.withDescription("Words that must all match"), Argument.variadic()),
  tag: Flag.String("tag").pipe(Flag.withDescription("Only items with this tag"), Flag.optional),
  json
}, handle(Effect.fn(function*({ json, query, tag }) {
  const items = (yield* listItems()).filter((i) =>
    matchesQuery(i, query) && Option.match(tag, { onNone: () => true, onSome: (t) => i.tags.includes(t) })
  )
  if (json) return yield* printJson(items)
  for (const item of items) yield* Console.log(line(item))
}))).pipe(Command.withDescription("List stored items, optionally filtered"))

const rm = Command.make("rm", {
  ids: idArg.pipe(Argument.atLeast(1)),
  force: Flag.Boolean("force").pipe(Flag.withDescription("Also remove the items from the collections that use them"), Flag.withDefault(false)),
  json
}, handle(Effect.fn(function*({ force, ids, json }) {
  const results = yield* tryEach(ids, (input) => deleteItem(input, force))
  yield* report(results, json, (r) => `removed\t${r.id}${r.removedFrom.length ? `\tfrom ${r.removedFrom.join(",")}` : ""}`)
}))).pipe(Command.withDescription("Delete stored items"))

const tagArgs = Argument.String("tag").pipe(
  Argument.atLeast(1),
  Argument.filter((ts) => ts.every((t) => /^[^\s,]+$/.test(t)), () => "tags must be non-empty and contain no spaces or commas")
)

const retag = (name: "tag" | "untag", update: (tags: ReadonlyArray<string>, given: ReadonlyArray<string>) => Array<string>) =>
  Command.make(name, { id: idArg, tags: tagArgs, json }, handle(Effect.fn(function*({ id, json, tags }) {
    const item = yield* findItem(id)
    const saved = yield* writeItem({ ...item, tags: update(item.tags, tags) })
    yield* json ? printJson(saved) : Console.log(`${saved.id}\t${saved.tags.join(",")}`)
  })))

const tag = retag("tag", (tags, given) => [...tags, ...given]).pipe(Command.withDescription("Add tags to an item"))
const untag = retag("untag", (tags, given) => tags.filter((t) => !given.includes(t))).pipe(Command.withDescription("Remove tags from an item"))

const note = Command.make("note", {
  id: idArg,
  text: Argument.String("text").pipe(Argument.withDescription("The note")),
  source: Flag.String("source").pipe(Flag.withDescription("Where the note comes from"), Flag.optional),
  json
}, handle(Effect.fn(function*({ id, json, source, text }) {
  const saved = yield* addNote(yield* findItem(id), text, Option.getOrUndefined(source))
  yield* json ? printJson(saved) : Console.log(`${saved.id}\t${saved.evidences.length} evidence(s)`)
}))).pipe(Command.withDescription("Append a note to an item's evidences"))

const init = Command.make("init", { json }, handle(Effect.fn(function*({ json }) {
  const fs = yield* FileSystem.FileSystem
  const root = (yield* Path.Path).resolve(".ibid")
  const created = !(yield* fs.exists(root).pipe(Effect.mapError(fail(root, "cannot stat"))))
  yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.mapError(fail(root, "cannot create")))
  if (process.env.IBID_DIR) yield* Console.error(`note: IBID_DIR is set and takes precedence over ${root}`)
  yield* json ? printJson({ root, created }) : Console.log(`${created ? "created" : "exists"}\t${root}`)
}))).pipe(Command.withDescription("Create a project store (.ibid/) in the current directory"))

const where = Command.make("where", { json }, handle(Effect.fn(function*({ json }) {
  const store = yield* findStore()
  yield* json ? printJson(store) : Console.log(`${store.root}\t${store.rule}`)
}))).pipe(Command.withDescription("Print the store in use and the rule that chose it (IBID_DIR, ancestor, global)"))

const exportCmd = Command.make("export", {
  name: Argument.String("collection").pipe(Argument.withDescription("Collection to export; every stored item when omitted"), Argument.optional),
  format: Flag.Literals("format", FORMATS).pipe(Flag.withDescription("md, text, html, rtf, bibtex, csl-json or dossier"), Flag.withDefault("md" as const)),
  style: Flag.String("style").pipe(
    Flag.withDescription(`${Object.keys(STYLES).join(", ")}, a path to a .csl file, or any style name from the CSL repository (fetched once, cached in the store); md, text, html and rtf only`),
    Flag.withDefault("vancouver")
  ),
  keepOrder: Flag.Boolean("keep-order").pipe(
    Flag.withDescription("Keep collection order in a non-numeric style instead of the style's sort (numeric styles always keep it)"),
    Flag.withDefault(false)
  )
}, handle(Effect.fn(function*({ format, keepOrder, name, style }) {
  const rows = yield* exportRows(Option.getOrUndefined(name))
  const resolved = isList(format) ? yield* resolveStyle(style) : "vancouver"
  const manual = rows.filter((r) => isManual(r.item)).length
  if (isList(format) && manual > 0 && !keepOrder && !isNumeric(yield* Effect.promise(() => styleXml(resolved)))) {
    yield* Console.error(`note: ${style} sorts its entries; ${manual} manual entr${manual === 1 ? "y is" : "ies are"} listed last (--keep-order keeps collection order)`)
  }
  const out = yield* Effect.tryPromise({
    try: () => render(rows, format, resolved, keepOrder),
    catch: (e) => usage(`cannot render with style ${style}: ${e instanceof Error ? e.message : String(e)}`)
  })
  yield* Console.log(out)
}))).pipe(Command.withDescription("Print a collection or the whole store as a reference list (Markdown, text, HTML or RTF), BibTeX, CSL-JSON or a dossier table"))

const find = Command.make("find", {
  title: Argument.String("title").pipe(Argument.withDescription("Title words"), Argument.atLeast(1)),
  author: Flag.String("author").pipe(Flag.withDescription("Keep candidates with this author family name"), Flag.optional),
  rows: Flag.Int("rows").pipe(Flag.withDescription("How many OpenAlex results to fetch"), Flag.withDefault(10)),
  json
}, handle(Effect.fn(function*({ author, json, rows, title }) {
  if (rows < 1 || rows > 200) return yield* usage("--rows must be between 1 and 200")
  const found = yield* findCandidates(title.join(" "), { rows, ...Option.match(author, { onNone: () => ({}), onSome: (a) => ({ author: a }) }) })
  if (json) return yield* printJson(found)
  for (const c of found) yield* Console.log(findLine(c))
  if (found.length === 0) yield* Console.error("no candidates")
}))).pipe(Command.withDescription("Search OpenAlex by title and list candidates (writes nothing; verify with add --expect-title)"))

const verify = Command.make("verify", {
  file: Argument.String("file").pipe(Argument.withDescription(".bib file, or any text/Markdown file with DOIs, PMIDs or arXiv ids")),
  json
}, handle(Effect.fn(function*({ file, json }) {
  const findings = yield* verifyFile(file)
  if (json) yield* printJson(findings)
  else for (const f of findings) yield* Console.log([f.status, f.location, f.id ?? "-", f.details].join("\t"))
  if (findings.length === 0 && !json) yield* Console.error("no citations found")
  const bad = findings.filter((f) => f.status !== "OK").length
  if (bad > 0) return yield* failWith(`${bad} of ${findings.length} finding(s) not OK`, json)
}))).pipe(Command.withDescription("Audit a .bib or Markdown file against the store and the registries (writes nothing)"))

Command.make("ibid").pipe(
  Command.withDescription("Verified local reference manager"),
  Command.withSubcommands([add, show, ls, override, rm, tag, untag, note, col, exportCmd, find, verify, init, where]),
  Command.run({ version: VERSION }),
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain
)
