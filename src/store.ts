import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { checkTitle, type Fetched } from "./resolve.ts"
import { type Csl, Item, StoreError } from "./schema.ts"

/** `doi:<lower-cased doi>` whenever there is a DOI, else `pmid:<n>`. */
export const itemKey = (csl: Csl, fallback: string) =>
  csl.DOI ? `doi:${csl.DOI.toLowerCase()}` : csl.PMID ? `pmid:${csl.PMID}` : fallback

export const fileName = (key: string) => {
  const i = key.indexOf(":")
  return `${key.slice(0, i)}_${encodeURIComponent(key.slice(i + 1))}.json`
}

export const keyFromFileName = (name: string) => {
  const base = name.replace(/\.json$/, "")
  const i = base.indexOf("_")
  return `${base.slice(0, i)}:${decodeURIComponent(base.slice(i + 1))}`
}

/** `$IBID_DIR/items`, defaulting to `./.ibid/items`. No upward search, no global store. */
const itemsDir = Effect.gen(function*() {
  return (yield* Path.Path).join(process.env.IBID_DIR || ".ibid", "items")
})

const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(Item))
const encodeItem = Schema.encodeEffect(Item)

const fail = (path: string, what: string) => (e: { message: string }) =>
  new StoreError({ path, message: `${what} ${path}: ${e.message}` })

export const readItem = Effect.fn("readItem")(function*(key: string) {
  const fs = yield* FileSystem.FileSystem
  const path = (yield* Path.Path).join(yield* itemsDir, fileName(key))
  if (!(yield* fs.exists(path).pipe(Effect.mapError(fail(path, "cannot stat"))))) return Option.none<Item>()
  const text = yield* fs.readFileString(path).pipe(Effect.mapError(fail(path, "cannot read")))
  return Option.some(yield* decodeItem(text).pipe(Effect.mapError(fail(path, "invalid item file"))))
})

export const listItems = Effect.fn("listItems")(function*() {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* itemsDir
  if (!(yield* fs.exists(dir).pipe(Effect.mapError(fail(dir, "cannot stat"))))) return []
  const names = (yield* fs.readDirectory(dir).pipe(Effect.mapError(fail(dir, "cannot list"))))
    .filter((n) => n.endsWith(".json"))
    .sort()
  const items = yield* Effect.forEach(names, (n) => readItem(keyFromFileName(n)))
  return items.flatMap(Option.toArray)
})

/**
 * Title-checks a fetched record and writes it, merging with what is already on disk:
 * evidences are kept verbatim, PubMed ids survive a refresh from doi.org, and a re-add
 * without --expect-title is re-checked against the title the item was verified with.
 */
export const upsertItem = Effect.fn("upsertItem")(function*(id: string, { canonical, verification }: Fetched, expectTitle?: string) {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* itemsDir
  const path = (yield* Path.Path).join(dir, fileName(id))
  const old = Option.getOrUndefined(yield* readItem(id))
  const title = yield* checkTitle(expectTitle ?? old?.verification.expectedTitle, canonical.title)
  const { PMCID, PMID } = old?.canonical ?? {}
  const item: Item = {
    id,
    canonical: { ...canonical, ...(PMID && !canonical.PMID ? { PMID } : {}), ...(PMCID && !canonical.PMCID ? { PMCID } : {}) },
    verification: { ...verification, ...title },
    evidences: old?.evidences ?? []
  }
  const json = JSON.stringify(yield* encodeItem(item).pipe(Effect.mapError(fail(path, "refusing to write invalid item"))), null, 2) + "\n"
  const tmp = `${path}.${process.pid}.tmp`
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(tmp, json)),
    Effect.andThen(fs.rename(tmp, path)),
    Effect.mapError(fail(path, "cannot write"))
  )
  return item
})
