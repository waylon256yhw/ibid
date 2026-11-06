#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { fetchCsl, parseId, type Ref, VERSION } from "./resolve.ts"
import { IdentifierNotFoundError, type IbidError, type Item } from "./schema.ts"
import { itemKey, listItems, readItem, upsertItem } from "./store.ts"

const json = Flag.Boolean("json").pipe(Flag.withDescription("Print only JSON on stdout"), Flag.withDefault(false))

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

const plain = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()

/** id, status, year, first author, title, container — tab separated. */
const line = ({ canonical: c, id, verification }: Item) => {
  const a = c.author?.[0]
  return [
    id,
    verification.titleMatch,
    c.issued?.["date-parts"][0]?.[0] ?? "-",
    a ? a.family ?? a.literal ?? a.given : "-",
    plain(c.title),
    c["container-title"] ?? c.publisher ?? "-"
  ].join("\t")
}

const errorJson = (e: IbidError) => ({ ...e, _tag: e._tag, message: e.message })

/** Domain errors become one-line CLI errors (no stack trace, exit 1). */
const userError = (e: IbidError) => new CliError.UserError({ cause: e, userMessage: e.message })

const keyOf = (ref: Ref) => ref.scheme === "doi" ? `doi:${ref.doi}` : `pmid:${ref.pmid}`

const fetchOne = Effect.fn("fetchOne")(function*(input: string) {
  const ref = yield* parseId(input)
  const fetched = yield* fetchCsl(ref)
  return { id: itemKey(fetched.canonical, keyOf(ref)), fetched }
})

const notOk = (input: string) => <E>(error: E) => Effect.succeed({ input, ok: false as const, error })

const add = Command.make("add", {
  ids: Argument.String("id").pipe(Argument.withDescription("doi:…, pmid:…, arxiv:…, 10.x DOI or https://doi.org/ URL"), Argument.atLeast(1)),
  expectTitle: Flag.String("expect-title").pipe(Flag.withDescription("Fail unless the registry title matches"), Flag.optional),
  json
}, Effect.fn(function*({ expectTitle, ids, json }) {
  const expected = Option.getOrUndefined(expectTitle)
  if (expected !== undefined && ids.length > 1) {
    return yield* new CliError.UserError({ cause: "usage", userMessage: "--expect-title can only be used with a single id" })
  }
  // Network in parallel (Crossref allows 3 at once). Disk writes one at a time, so two
  // inputs that resolve to the same paper merge instead of racing.
  const fetched = yield* Effect.forEach(ids, (input) =>
    fetchOne(input).pipe(
      Effect.map((f) => ({ input, ok: true as const, ...f })),
      Effect.catch(notOk(input))
    ), { concurrency: 3 })
  const results = yield* Effect.forEach(fetched, Effect.fnUntraced(function*(f) {
    if (!f.ok) return f
    return yield* upsertItem(f.id, f.fetched, expected).pipe(
      Effect.map((item) => ({ input: f.input, ok: true as const, item })),
      Effect.catch(notOk(f.input))
    )
  }))

  if (json) {
    yield* printJson(results.map((r) => r.ok ? r : { ...r, error: errorJson(r.error) }))
  } else {
    for (const r of results) {
      yield* r.ok ? Console.log(line(r.item)) : Console.error(`error\t${r.input}\t${r.error.message}`)
    }
  }
  const failed = results.filter((r) => !r.ok).length
  if (failed > 0) {
    return yield* new CliError.UserError({ cause: "add", userMessage: `${failed} of ${results.length} identifier(s) failed` })
  }
})).pipe(Command.withDescription("Fetch, verify and store items by identifier"))

const show = Command.make("show", {
  id: Argument.String("id"),
  json
}, Effect.fn(function*({ id, json }) {
  const ref = yield* parseId(id).pipe(Effect.mapError(userError))
  const key = keyOf(ref)
  let found = yield* readItem(key).pipe(Effect.mapError(userError))
  // Items fetched by PMID are keyed by DOI when they have one.
  if (Option.isNone(found) && ref.scheme === "pmid") {
    const all = yield* listItems().pipe(Effect.mapError(userError))
    found = Option.fromNullishOr(all.find((i) => i.canonical.PMID === ref.pmid))
  }
  if (Option.isNone(found)) {
    return yield* userError(new IdentifierNotFoundError({ id: key, message: `${key}: not in local store` }))
  }
  const item = found.value
  if (json) return yield* printJson(item)
  const c = item.canonical
  const v = item.verification
  yield* Console.log(line(item))
  const rows: Array<[string, string | undefined]> = [
    ["type", c.type],
    ["authors", c.author?.map((a) => a.literal ?? [a.family, a.given].filter(Boolean).join(", ")).join("; ")],
    ["issued", c.issued?.["date-parts"][0]?.join("-")],
    ["source", [c["container-title"], c.volume && `vol ${c.volume}`, c.issue && `no ${c.issue}`, c.page && `pp ${c.page}`].filter(Boolean).join(", ")],
    ["DOI", c.DOI],
    ["PMID", c.PMID],
    ["PMCID", c.PMCID],
    ["verified", `${v.titleMatch}${v.similarity !== undefined ? ` (${v.similarity})` : ""} via ${v.url} at ${v.fetchedAt}`],
    ["sha256", v.sha256],
    ["evidences", String(item.evidences.length)]
  ]
  for (const [k, val] of rows) if (val) yield* Console.log(`  ${k}: ${val}`)
})).pipe(Command.withDescription("Show one stored item"))

const ls = Command.make("ls", { json }, Effect.fn(function*({ json }) {
  const items = yield* listItems().pipe(Effect.mapError(userError))
  if (json) return yield* printJson(items)
  for (const item of items) yield* Console.log(line(item))
})).pipe(Command.withDescription("List stored items"))

Command.make("ibid").pipe(
  Command.withDescription("Verified local reference manager"),
  Command.withSubcommands([add, show, ls]),
  Command.run({ version: VERSION }),
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain
)
