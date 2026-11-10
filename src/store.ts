import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import { homedir } from "node:os"
import { checkTitle, type Fetched, parseId, type Ref } from "./resolve.ts"
import {
  type Csl,
  IdentifierNotFoundError,
  InvalidIdentifierError,
  isManual,
  Item,
  type ManualItem,
  type Note,
  type Overrides,
  type RegistryItem,
  StoreError
} from "./schema.ts"

/** `doi:<lower-cased doi>` whenever there is a DOI, else `pmid:<n>`, else `fallback`. */
export const itemKey = (csl: Csl, fallback: string) =>
  csl.DOI ? `doi:${csl.DOI.toLowerCase()}` : csl.PMID ? `pmid:${csl.PMID}` : fallback

export const keyOf = (ref: Ref) => ref.scheme === "doi" ? `doi:${ref.doi}` : ref.scheme === "pmid" ? `pmid:${ref.pmid}` : `pmc:${ref.pmc}`

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
    const text = yield* (yield* FileSystem.FileSystem).readFileString(path).pipe(
      Effect.map(Option.some),
      Effect.catchIf((e) => e.reason._tag === "NotFound", () => Effect.succeed(Option.none<string>())),
      Effect.mapError(fail(path, "cannot read"))
    )
    if (Option.isNone(text)) return Option.none<S["Type"]>()
    return Option.some((yield* decode(text.value).pipe(Effect.mapError(fail(path, `invalid ${what} file`)))) as S["Type"])
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

const READ_CONCURRENCY = 16

export const listItems = Effect.fn("listItems")(function*() {
  const path = yield* Path.Path
  const dir = yield* itemsDir
  const items = yield* Effect.forEach(yield* listJson(dir), (n) => readItemFile(path.join(dir, n)), { concurrency: READ_CONCURRENCY })
  return items.flatMap(Option.toArray)
})

/** The stored items among `keys`, by key; missing ones are left out. */
export const readItems = Effect.fn("readItems")(function*(keys: ReadonlyArray<string>) {
  const found = yield* Effect.forEach(new Set(keys), readItem, { concurrency: READ_CONCURRENCY })
  return new Map(found.flatMap(Option.toArray).map((i) => [i.id, i]))
})

/** Validates and writes an item; tags are sorted and de-duplicated on the way. */
export const writeItem = Effect.fn("writeItem")(function*<I extends Item>(item: I) {
  const dir = yield* itemsDir
  const path = (yield* Path.Path).join(dir, fileName(item.id))
  const clean: I = { ...item, tags: [...new Set(item.tags)].sort() }
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
  const manual = manualKey(input)
  if (manual) {
    const found = yield* readItem(manual)
    if (Option.isSome(found)) return found.value
    return yield* new IdentifierNotFoundError({ id: manual, message: `${manual}: not in local store` })
  }
  const ref = yield* parseId(input)
  const key = keyOf(ref)
  const direct = yield* readItem(key)
  if (Option.isSome(direct)) return direct.value
  // Ceiling: a PMID or PMCID for a DOI-keyed item reads every item file. Fine at hundreds of items; needs an index beyond that.
  if (ref.scheme !== "doi") {
    const hit = (yield* listItems()).find((i) =>
      !isManual(i) && (ref.scheme === "pmid" ? i.canonical.PMID === ref.pmid : i.canonical.PMCID === `PMC${ref.pmc}`)
    )
    if (hit) return hit
  }
  return yield* new IdentifierNotFoundError({ id: key, message: `${key}: not in local store` })
})

/**
 * Title-checks a fetched record and writes it, merging with what is already on disk:
 * evidences, tags and overrides are kept verbatim, PubMed ids survive a refresh from doi.org, and a
 * re-add without --expect-title is re-checked against the (registry) title the item was verified with.
 */
export const upsertItem = Effect.fn("upsertItem")(function*(id: string, { canonical, verification }: Fetched, expectTitle?: string) {
  const found = Option.getOrUndefined(yield* readItem(id))
  const old = found && !isManual(found) ? found : undefined
  const title = yield* checkTitle(expectTitle ?? old?.verification.expectedTitle, canonical.title)
  const { PMCID, PMID } = old?.canonical ?? {}
  const item = yield* writeItem<RegistryItem>({
    id,
    canonical: { ...canonical, ...(PMID && !canonical.PMID ? { PMID } : {}), ...(PMCID && !canonical.PMCID ? { PMCID } : {}) },
    verification: { ...verification, ...title },
    ...(old?.overrides && { overrides: old.overrides }),
    evidences: found?.evidences ?? [],
    tags: found?.tags ?? []
  })
  return { item, action: old ? "updated" as const : "created" as const,
    ...(old && old.verification.source !== verification.source && { previousSource: old.verification.source }) }
})

// ---------- manual entries ----------

const MANUAL = /^manual:[0-9a-f]+$/i

/** The store key of a `manual:<hash>` input, else undefined. */
export const manualKey = (input: string) => MANUAL.test(input.trim()) ? input.trim().toLowerCase() : undefined

export const manualText = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()

/** `manual:` and 10 hex digits of the normalized text, so the same text is the same item. */
export const manualId = (text: string) =>
  `manual:${new Bun.CryptoHasher("sha256").update(manualText(text)).digest("hex").slice(0, 10)}`

/** Stores a reference given as text; adding the same text again keeps its tags and evidences. */
export const addManual = Effect.fn("addManual")(function*(input: string) {
  const text = manualText(input)
  if (!text) return yield* new InvalidIdentifierError({ input, message: "--manual needs the reference text" })
  const id = manualId(text)
  const old = Option.getOrUndefined(yield* readItem(id))
  const item = yield* writeItem<ManualItem>({ id, manual: text, evidences: old?.evidences ?? [], tags: old?.tags ?? [] })
  return { item, action: old ? "updated" as const : "created" as const }
})

// ---------- overrides ----------

/** `override` flag names -> the CSL fields they replace. */
export const OVERRIDE_FIELDS = {
  title: "title",
  authors: "author",
  year: "issued",
  journal: "container-title",
  volume: "volume",
  issue: "issue",
  page: "page"
} as const
export type OverrideField = keyof typeof OVERRIDE_FIELDS

/**
 * `;` separates names. A name with a comma is family, given (at the first comma);
 * one without is a literal name, e.g. a group author.
 */
export const parseAuthors = (s: string) =>
  s.split(";").map((n) => n.trim()).filter(Boolean).map((n) => {
    const i = n.indexOf(",")
    if (i < 0) return { literal: n }
    const family = n.slice(0, i).trim()
    const given = n.slice(i + 1).trim()
    return { ...(family && { family }), ...(given && { given }) }
  }).filter((a) => Object.keys(a).length > 0)

/** `item` with `set` applied after dropping the `clear`ed fields (all of them with `clearAll`); no `overrides` key once none remain. */
export const withOverrides = (item: RegistryItem, set: Overrides, clear: ReadonlyArray<OverrideField>, clearAll = false): RegistryItem => {
  const drop = new Set<string>(clear.map((f) => OVERRIDE_FIELDS[f]))
  const kept = Object.entries(clearAll ? {} : item.overrides ?? {}).filter(([k]) => !drop.has(k))
  const overrides: Overrides = { ...Object.fromEntries(kept), ...set }
  const { overrides: _, ...rest } = item
  return Object.keys(overrides).length ? { ...rest, overrides } : rest
}

/**
 * The record every export, summary, query and comparison uses: the registry record with the
 * overrides applied, or for a manual entry its text as the title. An overridden year drops the
 * online-first date and an overridden journal the registry's short journal name.
 */
export const effective = (item: Item): Csl => {
  if (isManual(item)) return { type: "document", title: item.manual }
  const o = item.overrides
  if (!o) return item.canonical
  const { "issued-online": online, "container-title-short": short, ...rest } = item.canonical
  return {
    ...rest,
    ...(!o.issued && online && { "issued-online": online }),
    ...(!o["container-title"] && short && { "container-title-short": short }),
    ...o
  }
}

export const addNote = Effect.fn("addNote")(function*(item: Item, text: string, source?: string) {
  const note: Note = { text, ...(source !== undefined && { source }), addedAt: DateTime.formatIso(yield* DateTime.now) }
  return yield* writeItem({ ...item, evidences: [...item.evidences, note] })
})

export const plain = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()

export const year = (c: Csl) => c.issued?.["date-parts"][0]?.[0]

export const authorName = (a: NonNullable<Csl["author"]>[number]) => a.literal ?? [a.family, a.given].filter(Boolean).join(", ")

/** Every word must occur, case-insensitively, in id, title, authors, year, container title or tags. */
export const matchesQuery = (item: Item, words: ReadonlyArray<string>) => {
  const c = effective(item)
  const hay = [item.id, plain(c.title), ...(c.author ?? []).map(authorName), year(c), c["container-title"], ...item.tags]
    .filter((v) => v !== undefined)
    .join("\n")
    .toLowerCase()
  return words.every((w) => hay.includes(w.toLowerCase()))
}
