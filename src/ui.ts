import { Console, Data, Effect, Predicate, Runtime } from "effect"
import { CliError, Flag } from "effect/cli"
import { fetchCsl, parseId } from "./resolve.ts"
import type { IbidError, Item } from "./schema.ts"
import { findItem, itemKey, keyOf, plain, upsertItem, year } from "./store.ts"

export const json = Flag.Boolean("json").pipe(Flag.withDescription("Print only JSON on stdout"), Flag.withDefault(false))

export const expectTitle = Flag.String("expect-title").pipe(
  Flag.withDescription("Fail unless the registry title matches; give it once per id, in order"),
  Flag.atLeast(0)
)

export const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

/** id, status, year, first author, title, container — tab separated. */
export const line = ({ canonical: c, id, verification }: Item) => {
  const a = c.author?.[0]
  return [
    id,
    verification.titleMatch,
    year(c) ?? "-",
    a ? a.family ?? a.literal ?? a.given : "-",
    plain(c.title),
    c["container-title"] ?? c.publisher ?? "-"
  ].join("\t")
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

export type Result<A> = { input: string; ok: true } & A | { input: string; ok: false; error: IbidError }

const notOk = (input: string) => (error: IbidError) => Effect.succeed({ input, ok: false as const, error } as Result<never>)

const fetchOne = Effect.fn("fetchOne")(function*(input: string) {
  const ref = yield* parseId(input)
  const fetched = yield* fetchCsl(ref)
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
export const fetchAndStore = Effect.fn("fetchAndStore")(function*(ids: ReadonlyArray<string>, expectTitles?: ReadonlyArray<string>) {
  const fetched = yield* Effect.forEach(ids, (input) =>
    fetchOne(input).pipe(
      Effect.map((f) => ({ input, ok: true as const, ...f })),
      Effect.catch(notOk(input))
    ), { concurrency: 3 })
  return yield* Effect.forEach(fetched, Effect.fnUntraced(function*(f, i) {
    if (!f.ok) return f as Result<{ item: Item }>
    return yield* upsertItem(f.id, f.fetched, expectTitles?.[i]).pipe(
      Effect.map((item): Result<{ item: Item }> => ({ input: f.input, ok: true, item })),
      Effect.catch(notOk(f.input))
    )
  }))
})

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
  const missing = local.flatMap((r) => !r.ok && r.error._tag === "IdentifierNotFoundError" ? [r.input] : [])
  const fetched = yield* fetchAndStore(missing)
  return local.map((r) => !r.ok && r.error._tag === "IdentifierNotFoundError" ? fetched[missing.indexOf(r.input)]! : r)
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

/** Prints results (human: `ok` lines on stdout, errors on stderr) and fails if any failed. */
export const report = Effect.fn("report")(function*<A>(results: ReadonlyArray<Result<A>>, asJson: boolean, okLine: (r: A) => string) {
  if (asJson) {
    yield* printJson(results.map((r) => r.ok ? r : { ...r, error: errorJson(r.error) }))
  } else {
    for (const r of results) {
      yield* r.ok ? Console.log(okLine(r)) : Console.error(`error\t${r.input}\t${r.error.message}`)
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
