import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import { authorName, fail, findItem, keyOf, listJson, plain, readJson, removeItem, storeDir, writeJsonAtomic, year } from "./store.ts"
import { parseId } from "./resolve.ts"
import { Collection, CollectionError, type Entry, type Item, ItemReferencedError } from "./schema.ts"

const NAME = /^[a-z0-9][a-z0-9._-]*$/

const collectionsDir = storeDir("collections")
const readFile = readJson(Schema.fromJsonString(Collection), "collection")
const encode = Schema.encodeEffect(Collection)

const pathOf = Effect.fn("collectionPath")(function*(name: string) {
  if (!NAME.test(name)) {
    return yield* new CollectionError({ name, message: `invalid collection name "${name}": use lower-case letters, digits, ".", "_" or "-", starting with a letter or digit` })
  }
  return { dir: yield* collectionsDir, path: (yield* Path.Path).join(yield* collectionsDir, `${name}.json`) }
})

export const readCollection = Effect.fn("readCollection")(function*(name: string) {
  const found = yield* readFile((yield* pathOf(name)).path)
  if (Option.isNone(found)) return yield* new CollectionError({ name, message: `collection "${name}" does not exist` })
  return found.value
})

export const writeCollection = Effect.fn("writeCollection")(function*(col: Collection) {
  const { dir, path } = yield* pathOf(col.name)
  yield* writeJsonAtomic(dir, path, yield* encode(col).pipe(Effect.mapError(fail(path, "refusing to write invalid collection"))))
  return col
})

export const createCollection = Effect.fn("createCollection")(function*(name: string, title?: string) {
  const { path } = yield* pathOf(name)
  if (Option.isSome(yield* readFile(path))) return yield* new CollectionError({ name, message: `collection "${name}" already exists` })
  return yield* writeCollection({ name, ...(title !== undefined && { title }), createdAt: DateTime.formatIso(yield* DateTime.now), entries: [] })
})

export const deleteCollection = Effect.fn("deleteCollection")(function*(name: string) {
  yield* readCollection(name)
  const { path } = yield* pathOf(name)
  yield* (yield* FileSystem.FileSystem).remove(path).pipe(Effect.mapError(fail(path, "cannot delete")))
})

export const listCollections = Effect.fn("listCollections")(function*() {
  const dir = yield* collectionsDir
  const path = yield* Path.Path
  const cols = yield* Effect.forEach(yield* listJson(dir), (n) => readFile(path.join(dir, n)))
  return cols.flatMap(Option.toArray)
})

// ---------- entry operations (pure, 1-based positions) ----------

const bad = (col: Collection, message: string) => new CollectionError({ name: col.name, message: `${col.name}: ${message}` })

const checkPosition = (col: Collection, n: number, max: number) =>
  Number.isInteger(n) && n >= 1 && n <= max ? Effect.succeed(n) : Effect.fail(bad(col, `position ${n} out of range 1..${max}`))

/**
 * Adds `itemId`s not yet present (at `at`, consecutively, else at the end). Entries already
 * present stay where they are; their context/section are replaced when given.
 */
export const addEntries = (col: Collection, itemIds: ReadonlyArray<string>, opts: { context?: string; section?: string; at?: number } = {}) =>
  Effect.gen(function*() {
    const at = opts.at === undefined ? col.entries.length + 1 : yield* checkPosition(col, opts.at, col.entries.length + 1)
    const extra = { ...(opts.context !== undefined && { context: opts.context }), ...(opts.section !== undefined && { section: opts.section }) }
    const entries = col.entries.map((e) => ({ ...e }))
    const fresh: Array<Entry> = []
    const actions = new Map<string, "added" | "updated" | "unchanged">()
    for (const itemId of itemIds) {
      const i = entries.findIndex((e) => e.itemId === itemId)
      if (i >= 0) {
        if (Object.keys(extra).length > 0) entries[i] = { ...entries[i]!, ...extra }
        if (!actions.has(itemId)) actions.set(itemId, Object.keys(extra).length > 0 ? "updated" : "unchanged")
      } else if (!fresh.some((e) => e.itemId === itemId)) {
        fresh.push({ itemId, ...extra })
        actions.set(itemId, "added")
      }
    }
    entries.splice(at - 1, 0, ...fresh)
    return { col: { ...col, entries }, actions }
  })

/** A ref is a 1-based position or anything `findItem` accepts; returns the 0-based index. */
export const indexOfRef = Effect.fn("indexOfRef")(function*(col: Collection, ref: string) {
  if (/^\d+$/.test(ref)) return (yield* checkPosition(col, Number(ref), col.entries.length)) - 1
  // An item deleted from the store behind our back can still be removed by its key.
  const id = yield* findItem(ref).pipe(
    Effect.map((i) => i.id),
    Effect.catchTag("IdentifierNotFoundError", () => parseId(ref).pipe(Effect.map(keyOf)))
  )
  const i = col.entries.findIndex((e) => e.itemId === id)
  if (i < 0) return yield* bad(col, `${ref} is not in this collection`)
  return i
})

export const removeEntries = Effect.fn("removeEntries")(function*(col: Collection, refs: ReadonlyArray<string>) {
  // Resolve every ref against the original list first, so positions do not shift mid-way.
  const drop = new Set(yield* Effect.forEach(refs, (r) => indexOfRef(col, r)))
  return { ...col, entries: col.entries.filter((_, i) => !drop.has(i)) }
})

export const moveEntry = Effect.fn("moveEntry")(function*(col: Collection, ref: string, to: number) {
  const from = yield* indexOfRef(col, ref)
  yield* checkPosition(col, to, col.entries.length)
  const entries = [...col.entries]
  const [entry] = entries.splice(from, 1)
  entries.splice(to - 1, 0, entry!)
  return { ...col, entries }
})

export type SortKey = "year" | "author" | "title"

const sortValue = (item: Item | undefined, by: SortKey): string | number | undefined => {
  if (!item) return undefined
  const c = item.canonical
  if (by === "year") return year(c)
  if (by === "author") return c.author?.[0] ? authorName(c.author[0]).toLowerCase() : undefined
  return plain(c.title).toLowerCase()
}

/** Stable sort; entries with no value (or no stored item) go last either way. */
export const sortEntries = (col: Collection, items: ReadonlyMap<string, Item>, by: SortKey, desc = false): Collection => {
  const key = (e: Entry) => sortValue(items.get(e.itemId), by)
  const entries = [...col.entries].sort((a, b) => {
    const x = key(a)
    const y = key(b)
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1
    const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))
    return desc ? -d : d
  })
  return { ...col, entries }
}

/** Appends the sources' entries the target lacks, in order. */
export const mergeEntries = (target: Collection, sources: ReadonlyArray<Collection>): Collection => {
  const seen = new Set(target.entries.map((e) => e.itemId))
  const entries = [...target.entries]
  for (const e of sources.flatMap((s) => s.entries)) {
    if (!seen.has(e.itemId)) {
      seen.add(e.itemId)
      entries.push(e)
    }
  }
  return { ...target, entries }
}

/** Names of the collections that reference `itemId`. */
export const referencing = (cols: ReadonlyArray<Collection>, itemId: string) =>
  cols.filter((c) => c.entries.some((e) => e.itemId === itemId)).map((c) => c.name)

/**
 * Deletes a stored item. Refuses while a collection references it unless `force`, which
 * also drops its entries from those collections (after the item file is gone, so a failure
 * leaves a dangling entry rather than a silently shortened list).
 */
export const deleteItem = Effect.fn("deleteItem")(function*(input: string, force: boolean) {
  const item = yield* findItem(input)
  const cols = yield* listCollections()
  const usedBy = referencing(cols, item.id)
  if (usedBy.length > 0 && !force) {
    return yield* new ItemReferencedError({
      id: item.id,
      collections: usedBy,
      message: `${item.id} is used by collection(s) ${usedBy.join(", ")}; use --force to remove it from them too`
    })
  }
  yield* removeItem(item.id)
  for (const c of cols) {
    if (usedBy.includes(c.name)) yield* writeCollection({ ...c, entries: c.entries.filter((e) => e.itemId !== item.id) })
  }
  return { id: item.id, removedFrom: usedBy }
})
