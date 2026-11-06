import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import {
  addEntries,
  createCollection,
  deleteCollection,
  listCollections,
  mergeEntries,
  moveEntry,
  readCollection,
  removeEntries,
  sortEntries,
  writeCollection
} from "./collections.ts"
import type { Collection } from "./schema.ts"
import { readItems } from "./store.ts"
import { checkTitles, expectTitle, findOrFetch, handle, json, line, printJson, report, summary, withWarnings } from "./ui.ts"

const name = Argument.String("name").pipe(Argument.withDescription("Collection name, ^[a-z0-9][a-z0-9._-]*$"))
const ref = Argument.String("ref").pipe(Argument.withDescription("1-based position or item identifier"))

/** Numbered entries joined with the stored items; `[n]` is the citation number. JSON carries each item's `summary`. */
export const printCollection = Effect.fn("printCollection")(function*(col: Collection, asJson: boolean) {
  const items = yield* readItems(col.entries.map((e) => e.itemId))
  const entries = col.entries.map((e, i) => ({ position: i + 1, ...e, item: items.get(e.itemId) ?? null }))
  if (asJson) return yield* printJson({ ...col, entries: entries.map((e) => ({ ...e, item: e.item && summary(e.item) })) })
  yield* Console.log(`# ${col.name}${col.title ? `\t${col.title}` : ""}`)
  for (const e of entries) {
    yield* Console.log(`[${e.position}]\t${e.item ? line(e.item) : `${e.itemId}\tMISSING`}`)
    if (e.section) yield* Console.log(`  section: ${e.section}`)
    if (e.context) yield* Console.log(`  context: ${e.context}`)
  }
})

const create = Command.make("create", {
  name,
  title: Flag.String("title").pipe(Flag.withDescription("Human-readable title"), Flag.optional),
  json
}, handle(Effect.fn(function*({ json, name, title }) {
  const col = yield* createCollection(name, Option.getOrUndefined(title))
  yield* json ? printJson(col) : Console.log(`created\t${col.name}`)
}))).pipe(Command.withDescription("Create an empty collection"))

const ls = Command.make("ls", { json }, handle(Effect.fn(function*({ json }) {
  const cols = yield* listCollections()
  if (json) return yield* printJson(cols.map(({ entries, ...c }) => ({ ...c, count: entries.length })))
  for (const c of cols) yield* Console.log(`${c.name}\t${c.entries.length}\t${c.title ?? "-"}`)
}))).pipe(Command.withDescription("List collections: name, entry count, title"))

const show = Command.make("show", { name, json }, handle(Effect.fn(function*({ json, name }) {
  yield* printCollection(yield* readCollection(name), json)
}))).pipe(Command.withDescription("Show a collection's numbered entries"))

const add = Command.make("add", {
  name,
  ids: Argument.String("id").pipe(Argument.withDescription("Stored item (a manual:<hash> entry too), or an identifier to fetch and verify"), Argument.atLeast(1)),
  context: Flag.String("context").pipe(Flag.withDescription("Where it is cited, e.g. \"Slide 3\""), Flag.optional),
  section: Flag.String("section").pipe(Flag.withDescription("Section of the deliverable"), Flag.optional),
  at: Flag.Int("at").pipe(Flag.withDescription("Insert new entries at this 1-based position"), Flag.optional),
  expectTitle,
  json
}, handle(Effect.fn(function*({ at, context, expectTitle, ids, json, name, section }) {
  const before = yield* readCollection(name)
  const results = withWarnings(yield* findOrFetch(ids, yield* checkTitles(ids, expectTitle)))
  const found = results.flatMap((r) => r.ok ? [r.item.id] : [])
  const { actions, col } = yield* addEntries(before, found, {
    context: Option.getOrUndefined(context),
    section: Option.getOrUndefined(section),
    at: Option.getOrUndefined(at)
  })
  yield* writeCollection(col)
  const position = (id: string) => col.entries.findIndex((e) => e.itemId === id) + 1
  yield* report(
    results.map((r) => r.ok ? { ...r, action: actions.get(r.item.id)!, position: position(r.item.id) } : r),
    json,
    (r) => `${r.action}\t[${r.position}]\t${line(r.item)}`
  )
}))).pipe(Command.withDescription("Add items (fetching unknown ones); existing entries are updated, never duplicated"))

const rm = Command.make("rm", { name, refs: ref.pipe(Argument.atLeast(1)), json }, handle(Effect.fn(function*({ json, name, refs }) {
  yield* printCollection(yield* writeCollection(yield* removeEntries(yield* readCollection(name), refs)), json)
}))).pipe(Command.withDescription("Remove entries by position or item identifier"))

const move = Command.make("move", {
  name,
  ref,
  position: Argument.Int("position").pipe(Argument.withDescription("New 1-based position")),
  json
}, handle(Effect.fn(function*({ json, name, position, ref }) {
  yield* printCollection(yield* writeCollection(yield* moveEntry(yield* readCollection(name), ref, position)), json)
}))).pipe(Command.withDescription("Move one entry to a new position"))

const sort = Command.make("sort", {
  name,
  by: Flag.Literals("by", ["year", "author", "title"]).pipe(Flag.withDescription("Sort key")),
  desc: Flag.Boolean("desc").pipe(Flag.withDescription("Descending"), Flag.withDefault(false)),
  json
}, handle(Effect.fn(function*({ by, desc, json, name }) {
  const before = yield* readCollection(name)
  const items = yield* readItems(before.entries.map((e) => e.itemId))
  yield* printCollection(yield* writeCollection(sortEntries(before, items, by, desc)), json)
}))).pipe(Command.withDescription("Reorder entries by year, first author or title"))

const merge = Command.make("merge", {
  target: Argument.String("target"),
  sources: Argument.String("source").pipe(Argument.atLeast(1)),
  json
}, handle(Effect.fn(function*({ json, sources, target }) {
  const into = yield* readCollection(target)
  const from = yield* Effect.forEach(sources, readCollection)
  yield* printCollection(yield* writeCollection(mergeEntries(into, from)), json)
}))).pipe(Command.withDescription("Append the sources' entries the target lacks; sources are unchanged"))

const del = Command.make("delete", { name, json }, handle(Effect.fn(function*({ json, name }) {
  yield* deleteCollection(name)
  yield* json ? printJson({ deleted: name }) : Console.log(`deleted\t${name}`)
}))).pipe(Command.withDescription("Delete a collection (its items stay in the store)"))

export const col = Command.make("col").pipe(
  Command.withDescription("Ordered collections of items for one deliverable"),
  Command.withSubcommands([create, ls, show, add, rm, move, sort, merge, del])
)
