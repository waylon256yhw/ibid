#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { col } from "./col.ts"
import { deleteItem } from "./collections.ts"
import { exportRows, FORMATS, render, STYLES, type Style } from "./export.ts"
import { findCandidates } from "./find.ts"
import { VERSION } from "./resolve.ts"
import { addNote, authorName, fail, findItem, findStore, listItems, matchesQuery, writeItem } from "./store.ts"
import { evidenceText, fetchAndStore, handle, json, line, printJson, report, tryEach, usage } from "./ui.ts"
import { verifyFile } from "./verify.ts"

const idArg = Argument.String("id").pipe(Argument.withDescription("doi:…, pmid:…, arxiv:…, 10.x DOI or https://doi.org/ URL"))

const add = Command.make("add", {
  ids: idArg.pipe(Argument.atLeast(1)),
  expectTitle: Flag.String("expect-title").pipe(Flag.withDescription("Fail unless the registry title matches"), Flag.optional),
  json
}, handle(Effect.fn(function*({ expectTitle, ids, json }) {
  const expected = Option.getOrUndefined(expectTitle)
  if (expected !== undefined && ids.length > 1) return yield* usage("--expect-title can only be used with a single id")
  yield* report(yield* fetchAndStore(ids, expected), json, (r) => line(r.item))
}))).pipe(Command.withDescription("Fetch, verify and store items by identifier"))

const show = Command.make("show", { id: idArg, json }, handle(Effect.fn(function*({ id, json }) {
  const item = yield* findItem(id)
  if (json) return yield* printJson(item)
  const c = item.canonical
  const v = item.verification
  yield* Console.log(line(item))
  const rows: Array<[string, string | undefined]> = [
    ["type", c.type],
    ["authors", c.author?.map(authorName).join("; ")],
    ["issued", c.issued?.["date-parts"][0]?.join("-")],
    ["source", [c["container-title"], c.volume && `vol ${c.volume}`, c.issue && `no ${c.issue}`, c.page && `pp ${c.page}`].filter(Boolean).join(", ")],
    ["language", c.language],
    ["DOI", c.DOI],
    ["PMID", c.PMID],
    ["PMCID", c.PMCID],
    ["verified", `${v.titleMatch}${v.similarity !== undefined ? ` (${v.similarity})` : ""} via ${v.url} at ${v.fetchedAt}`],
    ["sha256", v.sha256],
    ["tags", item.tags.join(", ")],
    ...item.evidences.map((e): [string, string] => ["evidence", evidenceText(e)])
  ]
  for (const [k, val] of rows) if (val) yield* Console.log(`  ${k}: ${val}`)
}))).pipe(Command.withDescription("Show one stored item"))

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
  format: Flag.Literals("format", FORMATS).pipe(Flag.withDescription("md, text, bibtex, csl-json or dossier"), Flag.withDefault("md" as const)),
  style: Flag.Literals("style", Object.keys(STYLES) as Array<Style>).pipe(
    Flag.withDescription("apa, vancouver, harvard, nature, gb7714 or gb7714-2025 (md and text only)"),
    Flag.withDefault("vancouver" as Style)
  )
}, handle(Effect.fn(function*({ format, name, style }) {
  const rows = yield* exportRows(Option.getOrUndefined(name))
  yield* Console.log(yield* Effect.promise(() => render(rows, format, style)))
}))).pipe(Command.withDescription("Print a collection (in its order) or the whole store as a reference list, BibTeX, CSL-JSON or a dossier table"))

const find = Command.make("find", {
  title: Argument.String("title").pipe(Argument.withDescription("Title words"), Argument.atLeast(1)),
  author: Flag.String("author").pipe(Flag.withDescription("Keep candidates with this author family name"), Flag.optional),
  rows: Flag.Int("rows").pipe(Flag.withDescription("How many OpenAlex results to fetch"), Flag.withDefault(10)),
  json
}, handle(Effect.fn(function*({ author, json, rows, title }) {
  if (rows < 1 || rows > 200) return yield* usage("--rows must be between 1 and 200")
  const found = yield* findCandidates(title.join(" "), { rows, ...Option.match(author, { onNone: () => ({}), onSome: (a) => ({ author: a }) }) })
  if (json) return yield* printJson(found)
  for (const c of found) yield* Console.log([c.similarity, c.doi ? `doi:${c.doi}` : "-", c.year ?? "-", c.firstAuthor ?? "-", c.title].join("\t"))
  if (found.length === 0) yield* Console.error("no candidates")
}))).pipe(Command.withDescription("Search OpenAlex by title and list candidates (writes nothing; verify with add --expect-title)"))

const verify = Command.make("verify", {
  file: Argument.String("file").pipe(Argument.withDescription(".bib file, or any text/Markdown file with DOIs, PMIDs or arXiv ids")),
  json
}, handle(Effect.fn(function*({ file, json }) {
  const findings = yield* verifyFile(file)
  if (json) yield* printJson(findings)
  else for (const f of findings) yield* Console.log([f.status, f.location, f.id ?? "-", f.details].join("\t"))
  if (findings.length === 0) yield* Console.error("no citations found")
  const bad = findings.filter((f) => f.status !== "OK").length
  if (bad > 0) return yield* usage(`${bad} of ${findings.length} finding(s) not OK`)
}))).pipe(Command.withDescription("Audit a .bib or Markdown file against the store and the registries (writes nothing)"))

Command.make("ibid").pipe(
  Command.withDescription("Verified local reference manager"),
  Command.withSubcommands([add, show, ls, rm, tag, untag, note, col, exportCmd, find, verify, init, where]),
  Command.run({ version: VERSION }),
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain
)
