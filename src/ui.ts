import { Console, Data, Effect, Option, Predicate, Runtime } from "effect"
import { CliError, Flag } from "effect/cli"
import { fetchCsl, parseId, pubmedIdForDoi } from "./resolve.ts"
import { type Csl, type IbidError, isManual, type Item, type Overrides, type RegistryItem, InvalidIdentifierError, UpstreamError } from "./schema.ts"
import {
  authorName,
  withOverrides,
  writeItem,
  effective,
  findItem,
  itemKey,
  keyOf,
  manualKey,
  OVERRIDE_FIELDS,
  type OverrideField,
  plain,
  readItem,
  upsertItem,
  year
} from "./store.ts"

export const json = Flag.Boolean("json").pipe(Flag.withDescription("Print only JSON on stdout"), Flag.withDefault(false))

export const expectTitle = Flag.String("expect-title").pipe(
  Flag.withDescription("Fail unless the registry title matches; give it once per id, in order"),
  Flag.atLeast(0)
)

export const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

/** `MANUAL`, or the title check, with a trailing `*` when local overrides apply. */
export const status = (item: Item) => isManual(item) ? "MANUAL" : `${item.verification.titleMatch}${item.overrides ? "*" : ""}`

/** The effective record in brief: what `line` prints and what `col show --json` embeds. */
export const summary = (item: Item) => {
  const c = effective(item)
  const a = c.author?.[0]
  return {
    id: item.id,
    status: status(item),
    year: year(c) ?? null,
    firstAuthor: a ? a.family ?? a.literal ?? a.given ?? null : null,
    authorCount: c.author?.length ?? 0,
    title: plain(c.title),
    journal: c["container-title"] ?? c.publisher ?? null
  }
}

/** id, status, year, first author, title, container — tab separated. */
export const line = (item: Item) => {
  const s = summary(item)
  return [s.id, s.status, s.year ?? "-", s.firstAuthor ?? "-", s.title, s.journal ?? "-"].join("\t")
}

/** At most 10 names, then the total. */
export const authorsText = (as: Csl["author"]) =>
  as?.length ? `${as.slice(0, 10).map(authorName).join("; ")}${as.length > 10 ? `; … (${as.length} authors)` : ""}` : undefined

/** `2023-05-16`: month and day zero-padded. */
export const dateText = (d: Csl["issued"]) => d?.["date-parts"][0]?.map((n, i) => i === 0 ? String(n) : String(n).padStart(2, "0")).join("-")

const fieldText = (c: Csl, field: OverrideField) => {
  const key = OVERRIDE_FIELDS[field]
  return key === "author" ? authorsText(c.author) : key === "issued" ? dateText(c.issued) : c[key]
}

/** For each overridden field, the override and the registry value it hides. */
export const overrideLines = (item: RegistryItem) =>
  (Object.keys(OVERRIDE_FIELDS) as Array<OverrideField>).flatMap((f) =>
    item.overrides?.[OVERRIDE_FIELDS[f]] === undefined
      ? []
      : [`  override ${f}: ${fieldText(effective(item), f) ?? ""}`, `    registry: ${fieldText(item.canonical, f) ?? "(none)"}`]
  )

/** Human `show`: the summary line, the effective record's fields, then each override beside the registry value. */
export const showLines = (item: Item) => {
  const notes: Array<readonly [string, string | undefined]> = [["tags", item.tags.join(", ")], ...item.evidences.map((e, i) => [`evidence [${i + 1}]`, evidenceText(e) || "(empty)"] as const)]
  const field = ([k, v]: readonly [string, string | undefined]) => v ? [`  ${k}: ${v}`] : []
  if (isManual(item)) return [line(item), ...[["text", item.manual] as const, ["source", "manual entry, not from a registry"] as const, ...notes].flatMap(field)]
  const c = effective(item)
  const v = item.verification
  const rows: Array<readonly [string, string | undefined]> = [
    ["type", c.type],
    ["authors", authorsText(c.author)],
    ["issued", dateText(c.issued)],
    ["source", [c["container-title"], c.volume && `vol ${c.volume}`, c.issue && `no ${c.issue}`, c.page && `pp ${c.page}`].filter(Boolean).join(", ")],
    ["language", c.language],
    ["DOI", c.DOI],
    ["PMID", c.PMID],
    ["PMCID", c.PMCID],
    ["registry", v.source],
    ["verified", `${v.titleMatch}${v.similarity !== undefined ? ` (${v.similarity})` : ""} via ${v.url} at ${v.fetchedAt}`],
    ["sha256", v.sha256],
    ...notes
  ]
  return [line(item), ...rows.flatMap(field), ...overrideLines(item)]
}

/** A registry author list that is empty, unless the authors are overridden. */
export const authorWarnings = (item: Item): Array<string> => {
  if (isManual(item) || item.overrides?.author) return []
  const n = item.canonical.author?.length ?? 0
  const fix = `ibid override ${item.id} --authors "Family, Given; ..."`
  if (n === 0) return [`the registry record has no authors; if the work has any, set them with ${fix}`]
  return []
}

/** Evidence entries of any shape: notes print their text, anything else as compact JSON. */
export const evidenceText = (e: unknown) =>
  Predicate.isObject(e) && "text" in e && Predicate.isString(e.text)
    ? `${e.text}${"source" in e && Predicate.isString(e.source) ? ` [${e.source}]` : ""}`
    : JSON.stringify(e)

export const errorJson = (e: IbidError) => ({ ...e, _tag: e._tag, message: e.message })

/** Domain errors become one-line CLI errors (no stack trace, exit 1). */
export const userError = (e: IbidError) => new CliError.UserError({ cause: e, userMessage: e.message })

export const usage = (message: string) => new CliError.UserError({ cause: "usage", userMessage: message })

// ---------- per-id results, shared by `add`, `col add`, `rm` ----------

type StoredResult = { item: RegistryItem; action: "created" | "updated"; previousSource?: RegistryItem["verification"]["source"] }

export type Result<A> = { input: string; ok: true } & A | { input: string; ok: false; error: IbidError }

const notOk = (input: string) => (error: IbidError) => Effect.succeed({ input, ok: false as const, error } as Result<never>)

const fetchOne = Effect.fn("fetchOne")(function*(input: string, source?: "pubmed") {
  const ref = yield* parseId(input)
  if (source === "pubmed" && ref.scheme === "pmc") {
    return yield* new InvalidIdentifierError({ input, message: "--source pubmed accepts DOI or PMID inputs" })
  }
  let target = ref
  if (source === "pubmed" && ref.scheme === "doi") {
    const old = Option.getOrUndefined(yield* readItem(keyOf(ref)))
    const pmid = old && !isManual(old) ? old.canonical.PMID : undefined
    target = { scheme: "pmid", pmid: pmid ?? (yield* pubmedIdForDoi(ref.doi)) }
  }
  const fetched = yield* fetchCsl(target)
  if (source === "pubmed" && ref.scheme === "doi" && fetched.canonical.DOI !== ref.doi) {
    return yield* new UpstreamError({ url: fetched.verification.url,
      message: `PubMed DOI ${fetched.canonical.DOI ?? "(missing)"} does not match requested DOI ${ref.doi}` })
  }
  return { id: itemKey(fetched.canonical, keyOf(ref)), fetched }
})

/** `--expect-title` is given not at all, or once per id in the same order. */
export const checkTitles = (ids: ReadonlyArray<string>, titles: ReadonlyArray<string>) =>
  titles.length === 0 || titles.length === ids.length
    ? Effect.succeed(titles.length ? titles : undefined)
    : Effect.fail(usage(`--expect-title must be given once per id (${ids.length}) or not at all, got ${titles.length}`))

/**
 * The Stage 1 `add` pipeline: network in parallel (Crossref allows 3 at once), disk writes
 * one at a time, so two inputs that resolve to the same paper merge instead of racing.
 * `expectTitles[i]` is checked against `ids[i]`.
 */
export const fetchAndStore = Effect.fn("fetchAndStore")(function*(ids: ReadonlyArray<string>, expectTitles?: ReadonlyArray<string>, source?: "pubmed") {
  const fetched = yield* Effect.forEach(ids, (input) =>
    fetchOne(input, source).pipe(
      Effect.map((f) => ({ input, ok: true as const, ...f })),
      Effect.catch(notOk(input))
    ), { concurrency: source === "pubmed" ? 1 : 3 })
  return yield* Effect.forEach(fetched, Effect.fnUntraced(function*(f, i) {
    if (!f.ok) return f as Result<StoredResult>
    return yield* upsertItem(f.id, f.fetched, expectTitles?.[i]).pipe(
      Effect.map((stored): Result<StoredResult> => ({ input: f.input, ok: true, ...stored })),
      Effect.catch(notOk(f.input))
    )
  }))
})

/** `ibid override`: at least one change; a manual entry has no registry record to override. */
export const overrideItem = Effect.fn("overrideItem")(function*(input: string, set: Overrides, clear: ReadonlyArray<OverrideField>, clearAll: boolean) {
  if (Object.keys(set).length === 0 && clear.length === 0 && !clearAll) {
    return yield* usage("give a field to override (--title, --authors, --year, --journal, --volume, --issue, --page), --clear <field> or --clear-all")
  }
  const item = yield* findItem(input)
  if (isManual(item)) return yield* usage(`${item.id} is a manual entry with no registry record to override; add the corrected text with add --manual`)
  return yield* writeItem(withOverrides(item, set, clear, clearAll))
})

/** Adds each stored item's `authorWarnings` to its result (`add`, `col add`). */
export const withWarnings = <A extends { item: Item }>(results: ReadonlyArray<Result<A>>) =>
  results.map((r) => r.ok ? { ...r, warnings: authorWarnings(r.item) } : r)

/** Runs `f` for each input, collecting a per-input result instead of stopping at the first error. */
export const tryEach = <A extends object, R>(ids: ReadonlyArray<string>, f: (input: string) => Effect.Effect<A, IbidError, R>) =>
  Effect.forEach(ids, (input) =>
    f(input).pipe(
      Effect.map((a): Result<A> => ({ input, ok: true, ...a })),
      Effect.catch(notOk(input))
    ))

/** Items already stored are used as they are; the rest go through `fetchAndStore`. With titles, every id does. */
export const findOrFetch = Effect.fn("findOrFetch")(function*(ids: ReadonlyArray<string>, expectTitles?: ReadonlyArray<string>) {
  if (expectTitles) return yield* fetchAndStore(ids, expectTitles)
  const local = yield* tryEach(ids, (input) => findItem(input).pipe(Effect.map((item) => ({ item }))))
  // A manual entry exists only locally; there is nothing to fetch.
  const fetchable = (r: Result<{ item: Item }>) => !r.ok && r.error._tag === "IdentifierNotFoundError" && !manualKey(r.input)
  const missing = local.flatMap((r) => fetchable(r) ? [r.input] : [])
  const fetched = yield* fetchAndStore(missing)
  return local.map((r) => fetchable(r) ? fetched[missing.indexOf(r.input)]! : r)
})

/**
 * A failure whose report is already on stdout as JSON: exit 1 and print nothing more.
 * Without a user message `Command.run` does not render it, and the runtime does not log it.
 */
export class Reported extends Data.TaggedError("Reported")<{}> {
  override readonly [Runtime.errorReported] = false
}

/** Fails with `message` as a text error, or silently when the JSON on stdout already says it. */
export const failWith = (message: string, asJson: boolean): Effect.Effect<never, Reported | CliError.UserError> =>
  Effect.fail(asJson ? new Reported() : usage(message))

/**
 * Prints results (human: `ok` lines on stdout, errors and any `warnings` on stderr) and fails if any failed.
 * Warnings never change the exit code.
 */
export const report = Effect.fn("report")(function*<A>(results: ReadonlyArray<Result<A>>, asJson: boolean, okLine: (r: A) => string) {
  if (asJson) {
    yield* printJson(results.map((r) => r.ok ? r : { ...r, error: errorJson(r.error) }))
  } else {
    for (const r of results) {
      if (!r.ok) {
        yield* Console.error(`error\t${r.input}\t${r.error.message}`)
        continue
      }
      yield* Console.log(okLine(r))
      for (const w of (r as { warnings?: ReadonlyArray<string> }).warnings ?? []) yield* Console.error(`warning\t${r.input}\t${w}`)
    }
  }
  const failed = results.filter((r) => !r.ok).length
  if (failed > 0) return yield* failWith(`${failed} of ${results.length} identifier(s) failed`, asJson)
})

/**
 * Wraps a command handler so domain errors surface as one-line `UserError`s, or, under
 * `--json`, as one `{"error": {...}}` value on stdout and a silent exit 1.
 */
export const handle = <A, R>(f: (a: A) => Effect.Effect<void, IbidError | CliError.UserError | Reported, R>) => (a: A) =>
  f(a).pipe(Effect.catch((e): Effect.Effect<never, CliError.UserError | Reported> => {
    if (e._tag === "Reported") return Effect.fail(e)
    if (!(a as { json?: boolean }).json) return Effect.fail(e._tag === "UserError" ? e : userError(e))
    const error = e._tag === "UserError" ? { _tag: "UsageError", message: e.message } : errorJson(e)
    return printJson({ error }).pipe(Effect.andThen(Effect.fail(new Reported())))
  }))
