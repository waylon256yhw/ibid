import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import { homedir } from "node:os"
import { checkTitle, type Fetched, parseId, type Ref } from "./resolve.ts"
import { type Csl, IdentifierNotFoundError, Item, type Note, StoreError } from "./schema.ts"

/** `doi:<lower-cased doi>` whenever there is a DOI, else `pmid:<n>`. */
export const itemKey = (csl: Csl, fallback: string) =>
  csl.DOI ? `doi:${csl.DOI.toLowerCase()}` : csl.PMID ? `pmid:${csl.PMID}` : fallback

export const keyOf = (ref: Ref) => ref.scheme === "doi" ? `doi:${ref.doi}` : `pmid:${ref.pmid}`

export const fileName = (key: string) => {
  const i = key.indexOf(":")
  return `${key.slice(0, i)}_${encodeURIComponent(key.slice(i + 1))}.json`
}

export const keyFromFileName = (name: string) => {
  const base = name.replace(/\.json$/, "")
  const i = base.indexOf("_")
  return `${base.slice(0, i)}:${decodeURIComponent(base.slice(i + 1))}`
}

export const fail = (path: string, what: string) => (e: { message: string }) =>
  new StoreError({ path, message: `${what} ${path}: ${e.message}` })

// ---------- store discovery ----------

export type StoreRule = "IBID_DIR" | "ancestor" | "global"

/**
 * 1. `$IBID_DIR`; 2. `<dir>/.ibid` for the nearest ancestor `dir` of `cwd` (inclusive) that has one;
 * 3. `${XDG_DATA_HOME:-~/.local/share}/ibid`.
 */
export const findStore = Effect.fn("findStore")(function*(cwd = process.cwd(), env: Record<string, string | undefined> = process.env) {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  if (env.IBID_DIR) return { root: path.resolve(cwd, env.IBID_DIR), rule: "IBID_DIR" as StoreRule }
  for (let dir = path.resolve(cwd);; dir = path.dirname(dir)) {
    const candidate = path.join(dir, ".ibid")
    const info = yield* fs.stat(candidate).pipe(Effect.option)
    if (Option.isSome(info) && info.value.type === "Directory") return { root: candidate, rule: "ancestor" as StoreRule }
    if (path.dirname(dir) === dir) break
  }
  const data = env.XDG_DATA_HOME || path.join(env.HOME || homedir(), ".local", "share")
  return { root: path.join(data, "ibid"), rule: "global" as StoreRule }
})

/** `<store root>/<sub>` */
export const storeDir = (sub: string) =>
  Effect.gen(function*() {
    return (yield* Path.Path).join((yield* findStore()).root, sub)
  })

/** Writes `value` as pretty JSON through a temp file and a rename. */
export const writeJsonAtomic = Effect.fn("writeJsonAtomic")(function*(dir: string, path: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  const tmp = `${path}.${process.pid}.tmp`
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(tmp, JSON.stringify(value, null, 2) + "\n")),
    Effect.andThen(fs.rename(tmp, path)),
    Effect.mapError(fail(path, "cannot write"))
  )
})

/** Reads and decodes a JSON file, or none when it is missing. */
export const readJson = <S extends Schema.Codec<any, string>>(schema: S, what: string) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return Effect.fn("readJson")(function*(path: string) {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path).pipe(Effect.mapError(fail(path, "cannot stat"))))) return Option.none<S["Type"]>()
    const text = yield* fs.readFileString(path).pipe(Effect.mapError(fail(path, "cannot read")))
    return Option.some((yield* decode(text).pipe(Effect.mapError(fail(path, `invalid ${what} file`)))) as S["Type"])
  })
}

/** Sorted `.json` file names of `dir`, empty when it does not exist. */
export const listJson = Effect.fn("listJson")(function*(dir: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(dir).pipe(Effect.mapError(fail(dir, "cannot stat"))))) return []
  return (yield* fs.readDirectory(dir).pipe(Effect.mapError(fail(dir, "cannot list"))))
    .filter((n) => n.endsWith(".json"))
    .sort()
})

// ---------- items ----------

const itemsDir = storeDir("items")
const readItemFile = readJson(Schema.fromJsonString(Item), "item")
const encodeItem = Schema.encodeEffect(Item)

export const readItem = Effect.fn("readItem")(function*(key: string) {
  return yield* readItemFile((yield* Path.Path).join(yield* itemsDir, fileName(key)))
})

export const listItems = Effect.fn("listItems")(function*() {
  const path = yield* Path.Path
  const dir = yield* itemsDir
  const items = yield* Effect.forEach(yield* listJson(dir), (n) => readItemFile(path.join(dir, n)))
  return items.flatMap(Option.toArray)
})

/** Validates and writes an item; tags are sorted and de-duplicated on the way. */
export const writeItem = Effect.fn("writeItem")(function*(item: Item) {
  const dir = yield* itemsDir
  const path = (yield* Path.Path).join(dir, fileName(item.id))
  const clean: Item = { ...item, tags: [...new Set(item.tags)].sort() }
  const encoded = yield* encodeItem(clean).pipe(Effect.mapError(fail(path, "refusing to write invalid item")))
  yield* writeJsonAtomic(dir, path, encoded)
  return clean
})

export const removeItem = Effect.fn("removeItem")(function*(key: string) {
  const fs = yield* FileSystem.FileSystem
  const path = (yield* Path.Path).join(yield* itemsDir, fileName(key))
  yield* fs.remove(path).pipe(Effect.mapError(fail(path, "cannot delete")))
})

/**
 * The one lookup every command uses: any form `parseId` accepts, and a PMID also finds
 * an item keyed by its DOI.
 */
export const findItem = Effect.fn("findItem")(function*(input: string) {
  const ref = yield* parseId(input)
  const key = keyOf(ref)
  const direct = yield* readItem(key)
  if (Option.isSome(direct)) return direct.value
  if (ref.scheme === "pmid") {
    const hit = (yield* listItems()).find((i) => i.canonical.PMID === ref.pmid)
    if (hit) return hit
  }
  return yield* new IdentifierNotFoundError({ id: key, message: `${key}: not in local store` })
})

/**
 * Title-checks a fetched record and writes it, merging with what is already on disk:
 * evidences and tags are kept verbatim, PubMed ids survive a refresh from doi.org, and a
 * re-add without --expect-title is re-checked against the title the item was verified with.
 */
export const upsertItem = Effect.fn("upsertItem")(function*(id: string, { canonical, verification }: Fetched, expectTitle?: string) {
  const old = Option.getOrUndefined(yield* readItem(id))
  const title = yield* checkTitle(expectTitle ?? old?.verification.expectedTitle, canonical.title)
  const { PMCID, PMID } = old?.canonical ?? {}
  return yield* writeItem({
    id,
    canonical: { ...canonical, ...(PMID && !canonical.PMID ? { PMID } : {}), ...(PMCID && !canonical.PMCID ? { PMCID } : {}) },
    verification: { ...verification, ...title },
    evidences: old?.evidences ?? [],
    tags: old?.tags ?? []
  })
})

export const addNote = Effect.fn("addNote")(function*(item: Item, text: string, source?: string) {
  const note: Note = { text, ...(source !== undefined && { source }), addedAt: DateTime.formatIso(yield* DateTime.now) }
  return yield* writeItem({ ...item, evidences: [...item.evidences, note] })
})

export const plain = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()

export const year = (c: Csl) => c.issued?.["date-parts"][0]?.[0]

export const authorName = (a: NonNullable<Csl["author"]>[number]) => a.literal ?? [a.family, a.given].filter(Boolean).join(", ")

/** Every word must occur, case-insensitively, in id, title, authors, year, container title or tags. */
export const matchesQuery = (item: Item, words: ReadonlyArray<string>) => {
  const c = item.canonical
  const hay = [item.id, plain(c.title), ...(c.author ?? []).map(authorName), year(c), c["container-title"], ...item.tags]
    .filter((v) => v !== undefined)
    .join("\n")
    .toLowerCase()
  return words.every((w) => hay.includes(w.toLowerCase()))
}
