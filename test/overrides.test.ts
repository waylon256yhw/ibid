import { BunServices } from "@effect/platform-bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestConsole } from "effect/testing"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import crossref from "./fixtures/crossref-numpy.json" with { type: "json" }
import datacite from "./fixtures/datacite-arxiv.json" with { type: "json" }
import { printCollection } from "../src/col.ts"
import { addEntries, createCollection, moveEntry, readCollection, removeEntries, writeCollection } from "../src/collections.ts"
import { exportRows, render } from "../src/export.ts"
import { findLine } from "../src/find.ts"
import { type Fetched, normalizeCsl, RawCsl } from "../src/resolve.ts"
import type { Collection, Csl, Item, RegistryItem } from "../src/schema.ts"
import { addManual, effective, findItem, manualId, matchesQuery, parseAuthors, readItem, upsertItem, withOverrides, writeItem } from "../src/store.ts"
import { authorWarnings, line, overrideItem, report, showLines, withWarnings } from "../src/ui.ts"
import { verifyFile } from "../src/verify.ts"

const normalize = (raw: unknown) => normalizeCsl(Schema.decodeUnknownSync(RawCsl)(raw))
const numpy = normalize(crossref) // Harris 2020, Nature 585:357-362
const attention = normalize(datacite) // Vaswani 2017
const fetched = (canonical: Csl): Fetched => ({ canonical, verification: { source: "doi.org", url: "u", fetchedAt: "t", sha256: "h" } })
const NUMPY = "doi:10.1038/s41586-020-2649-2"
const ATTENTION = "doi:10.48550/arxiv.1706.03762"
const TEXT = "Doe J. A report with no identifier. Agency; 2019."

const services = Layer.mergeAll(BunServices.layer, TestConsole.layer)
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromiseExit(Effect.provide(e, services) as Effect.Effect<A, E>)
const ok = async <A, E>(e: Effect.Effect<A, E, any>) => {
  const exit = await run(e)
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
  return exit.value
}
const failure = (exit: Exit.Exit<unknown, unknown>) => {
  const e = Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) as any : undefined
  return e && { tag: e._tag as string, message: String(e.userMessage ?? e.message) }
}
const withConsole = <A, E>(e: Effect.Effect<A, E, any>) =>
  Effect.runPromise(Effect.gen(function*() {
    const exit = yield* Effect.exit(e)
    return { exit, out: (yield* TestConsole.logLines).map(String), err: (yield* TestConsole.errorLines).map(String) }
  }).pipe(Effect.provide(services)) as Effect.Effect<any>)

const dir = mkdtempSync(join(tmpdir(), "ibid-overrides-"))
beforeAll(() => {
  process.env.IBID_DIR = dir
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const stored = async (id: string) => (await ok(findItem(id))) as RegistryItem

describe("author parsing", () => {
  test("; separates names; a comma splits family and given; no comma is a literal name", () => {
    expect(parseAuthors("Joseph, Philip; Roy, Ambuj ;Lonn,Eva")).toEqual([
      { family: "Joseph", given: "Philip" },
      { family: "Roy", given: "Ambuj" },
      { family: "Lonn", given: "Eva" }
    ])
    expect(parseAuthors("PURE Investigators; Smith, John, Jr")).toEqual([{ literal: "PURE Investigators" }, { family: "Smith", given: "John, Jr" }])
    expect(parseAuthors("Madonna,; ; ")).toEqual([{ family: "Madonna" }])
    expect(parseAuthors(" ; ")).toEqual([])
  })
})

describe("overrides", () => {
  test("apply to the effective record only; canonical and overrides stay separate keys", async () => {
    await ok(upsertItem(NUMPY, fetched(numpy), "Array programming with NumPy"))
    const saved = await ok(overrideItem(NUMPY, { author: [{ family: "Doe", given: "Jane" }], issued: { "date-parts": [[2021]] } }, [], false))
    expect(saved.canonical).toEqual((await stored(NUMPY)).canonical)
    expect(saved.canonical.author?.[0]).toEqual({ family: "Harris", given: "Charles R." })
    expect(saved.overrides).toEqual({ author: [{ family: "Doe", given: "Jane" }], issued: { "date-parts": [[2021]] } })
    expect(effective(saved).author).toEqual([{ family: "Doe", given: "Jane" }])
    expect(effective(saved).volume).toBe("585")
    expect(Object.keys(JSON.parse(JSON.stringify(saved)))).toEqual(expect.arrayContaining(["canonical", "overrides"]))
    // Summary line, ls query.
    expect(line(saved).split("\t").slice(1, 4)).toEqual(["VERIFIED*", "2021", "Doe"])
    expect(matchesQuery(saved, ["doe", "2021"])).toBe(true)
    expect(matchesQuery(saved, ["harris"])).toBe(false)
  })

  test("used by every export format", async () => {
    const rows = [{ item: await stored(NUMPY) }]
    expect(await render(rows, "text", "vancouver")).toStartWith("1. Doe J. Array programming with NumPy. Nature. 2021")
    expect(await render(rows, "bibtex", "vancouver")).toContain("author = {Doe, Jane}")
    expect(JSON.parse(await render(rows, "csl-json", "vancouver"))[0].author).toEqual([{ family: "Doe", given: "Jane" }])
    expect(await render(rows, "dossier", "vancouver")).toContain("| Doe, 2021 |")
  })

  test("survive a re-add, which still checks the registry title", async () => {
    const again = await ok(upsertItem(NUMPY, fetched({ ...numpy, volume: "999" })))
    expect(again.canonical.volume).toBe("999")
    expect(again.overrides?.author).toEqual([{ family: "Doe", given: "Jane" }])
    expect(again.verification.titleMatch).toBe("VERIFIED")
    expect(failure(await run(upsertItem(NUMPY, fetched(numpy), "Doe and the overridden title")))?.tag).toBe("TitleMismatchError")
    await ok(upsertItem(NUMPY, fetched(numpy)))
  })

  test("show prints each override beside the registry value", async () => {
    const lines = showLines(await stored(NUMPY))
    expect(lines).toContain("  authors: Doe, Jane")
    expect(lines.slice(-4)).toEqual([
      "  override authors: Doe, Jane",
      "    registry: Harris, Charles R.; Millman, K. Jarrod",
      "  override year: 2021",
      "    registry: 2020-09-16"
    ])
  })

  test("verify compares a stored item with its overrides applied", async () => {
    const bib = join(dir, "claims.bib")
    writeFileSync(bib, "@article{a, title={Array programming with NumPy}, author={Doe, Jane}, year={2021}, journal={Nature}, volume={585}, pages={357--362}, doi={10.1038/s41586-020-2649-2}}\n")
    // The store answers; any registry request would fail the test.
    const offline = Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("no network in tests", { status: 500 })))
    ))
    const findings = await ok(Effect.provide(verifyFile(bib), offline))
    expect(findings.map((f) => f.status)).toEqual(["OK"])
  })

  test("clear one field, then all; at least one change is required", async () => {
    const one = await ok(overrideItem(NUMPY, {}, ["year"], false))
    expect(one.overrides).toEqual({ author: [{ family: "Doe", given: "Jane" }] })
    const none = await ok(overrideItem(NUMPY, {}, [], true))
    expect("overrides" in none).toBe(false)
    expect(line(none).split("\t")[1]).toBe("VERIFIED")
    expect(failure(await run(overrideItem(NUMPY, {}, [], false)))?.tag).toBe("UserError")
    // Clearing comes first.
    expect(withOverrides(none, { title: "T" }, ["title"]).overrides).toEqual({ title: "T" })
  })
})

describe("abnormal author lists and output size", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ family: `F${i + 1}`, given: "G" }))
  const item = (author: Csl["author"]): RegistryItem => ({
    id: "doi:10.1/x",
    canonical: { type: "article-journal", title: "T", ...(author && { author }), issued: { "date-parts": [[2023, 5, 6]] } },
    verification: { source: "doi.org", url: "u", fetchedAt: "t", sha256: "h", titleMatch: "UNCHECKED" },
    evidences: [],
    tags: []
  })

  test("warn on no authors and on more than 50, not when overridden", () => {
    expect(authorWarnings(item(undefined))[0]).toContain("no authors")
    expect(authorWarnings(item(many(51)))[0]).toContain("lists 51 authors")
    expect(authorWarnings(item(many(51)))[0]).toContain("ibid override doi:10.1/x --authors")
    expect(authorWarnings(item(many(50)))).toEqual([])
    expect(authorWarnings({ ...item(many(300)), overrides: { author: [{ literal: "Group" }] } })).toEqual([])
  })

  test("warnings go to stderr in human mode and into the result under --json; the exit code is unchanged", async () => {
    const results = withWarnings([{ input: "10.1/x", ok: true as const, item: item(many(335)) }])
    const human = await withConsole(report(results, false, () => "ok line"))
    expect(Exit.isSuccess(human.exit)).toBe(true)
    expect(human.out).toEqual(["ok line"])
    expect(human.err).toEqual([`warning\t10.1/x\t${authorWarnings(item(many(335)))[0]}`])
    const json = await withConsole(report(results, true, () => ""))
    expect(Exit.isSuccess(json.exit)).toBe(true)
    expect(JSON.parse(json.out[0]!)[0].warnings).toEqual([expect.stringContaining("335 authors")])
  })

  test("show: at most 10 authors, then the count; zero-padded dates", () => {
    const lines = showLines(item(many(2284)))
    expect(lines).toContain("  authors: F1, G; F2, G; F3, G; F4, G; F5, G; F6, G; F7, G; F8, G; F9, G; F10, G; … (2284 authors)")
    expect(lines).toContain("  issued: 2023-05-06")
  })

  test("col show --json embeds a compact summary per entry", async () => {
    await ok(createCollection("compact"))
    await ok(writeItem(item(many(400))))
    await ok(writeCollection({ ...(await ok(readCollection("compact"))), entries: [{ itemId: "doi:10.1/x", context: "Slide 1" }, { itemId: "doi:10.1/gone" }] }))
    const r = await withConsole(printCollection(await ok(readCollection("compact")), true))
    const shown = JSON.parse(r.out[0]!)
    expect(shown.entries).toEqual([
      {
        position: 1,
        itemId: "doi:10.1/x",
        context: "Slide 1",
        item: { id: "doi:10.1/x", status: "UNCHECKED", year: 2023, firstAuthor: "F1", authorCount: 400, title: "T", journal: null }
      },
      { position: 2, itemId: "doi:10.1/gone", item: null }
    ])
  })
})

describe("manual entries", () => {
  test("the id depends only on the normalized text; re-adding keeps tags", async () => {
    const a = await ok(addManual(TEXT))
    expect(a.id).toMatch(/^manual:[0-9a-f]{10}$/)
    expect(a.id).toBe(manualId(`  ${TEXT.replace(/ /g, "\n ")} `))
    await ok(writeItem({ ...a, tags: ["grey"] }))
    const b = await ok(addManual(`${TEXT}  `))
    expect(b).toEqual({ id: a.id, manual: TEXT, evidences: [], tags: ["grey"] })
    expect(line(b).split("\t")).toEqual([a.id, "MANUAL", "-", "-", TEXT, "-"])
    expect(showLines(b)).toContain(`  text: ${TEXT}`)
    expect(failure(await run(addManual("  ")))?.tag).toBe("InvalidIdentifierError")
  })

  test("override refuses a manual entry", async () => {
    const exit = await run(overrideItem(manualId(TEXT), { title: "x" }, [], false))
    expect(failure(exit)).toEqual({ tag: "UserError", message: expect.stringContaining("is a manual entry") })
  })

  const rows = async () => {
    await ok(upsertItem(NUMPY, fetched(numpy)))
    await ok(upsertItem(ATTENTION, fetched(attention)))
    // Manual entries take part in col add (by id, --at), move and rm like any other entry.
    const col: Collection = { name: "mixed", createdAt: "x", entries: [{ itemId: NUMPY }, { itemId: ATTENTION }] }
    const withManual = (await ok(addEntries(col, [(await ok(findItem(manualId(TEXT)))).id], { at: 2 }))).col
    expect(withManual.entries.map((e) => e.itemId)).toEqual([NUMPY, manualId(TEXT), ATTENTION])
    expect((await ok(moveEntry(withManual, manualId(TEXT), 3))).entries.map((e) => e.itemId)).toEqual([NUMPY, ATTENTION, manualId(TEXT)])
    expect((await ok(removeEntries(withManual, [manualId(TEXT)]))).entries.length).toBe(2)
    await ok(writeCollection(withManual))
    return await ok(exportRows("mixed"))
  }

  test("numeric styles: the text as written, at its position, numbered like its neighbours", async () => {
    const r = await rows()
    const vancouver = (await render(r, "text", "vancouver")).split("\n")
    expect(vancouver.map((l) => l.slice(0, 9))).toEqual(["1. Harris", "2. Doe J.", "3. Vaswan"])
    expect(vancouver[1]).toBe(`2. ${TEXT}`)
    expect((await render(r, "md", "gb7714")).split("\n")[1]).toBe(`[2] ${TEXT}`)
    expect(await render(r, "html", "vancouver")).toContain(`<span style="display:inline-block;min-width:2.5em">2. </span>${TEXT}</p>`)
    expect(await render(r, "rtf", "gb7714")).toContain(`\\pard\\li720\\fi-720\\tx720\\sa120 [2]\\tab ${TEXT}\\par`)
  })

  test("a sorting style puts manual entries last, unless keepOrder", async () => {
    const r = await rows()
    expect((await render(r, "text", "apa")).split("\n").at(-1)).toBe(TEXT)
    expect((await render(r, "text", "apa", true)).split("\n")[1]).toBe(TEXT)
  })

  test("bibtex @misc with the text in note, csl-json marked, dossier row", async () => {
    const r = await rows()
    const bib = await render(r, "bibtex", "vancouver")
    const key = manualId(TEXT).replace(":", "")
    expect(bib.split("\n\n").map((e) => e.slice(0, 6))).toEqual(["@artic", "@misc{", "@artic"])
    expect(bib).toContain(`@misc{${key},\n\tnote = {${TEXT}}\n}`)
    const csl = JSON.parse(await render(r, "csl-json", "vancouver"))
    expect(csl[1]).toEqual({ id: manualId(TEXT), type: "document", title: TEXT, custom: { "ibid-manual": true } })
    expect((await render(r, "dossier", "vancouver")).split("\n")[3]).toBe(`| 2 | (manual entry) | ${TEXT} |  |  |`)
  })

  test("escaping: RTF non-ASCII and BibTeX specials", async () => {
    const odd = await ok(addManual("Zhang S. 指南 {draft} 50% & more_x"))
    const rows = [{ item: odd as Item }]
    expect(await render(rows, "rtf", "vancouver")).toContain("\\uc0\\u25351{}\\uc0\\u21335{} \\{draft\\}")
    expect(await render(rows, "bibtex", "vancouver")).toContain("note = {Zhang S. 指南 \\{draft\\} 50\\% \\& more\\_x}")
  })
})

describe("find text output", () => {
  test("has a type column after the year", () => {
    expect(findLine({ similarity: 1, doi: "10.1/a", year: 2001, type: "review", firstAuthor: "A B", title: "T", openalex: "W1" }))
      .toBe("1\tdoi:10.1/a\t2001\treview\tA B\tT")
    expect(findLine({ similarity: 0.5, title: "T", openalex: "W2" })).toBe("0.5\t-\t-\t-\t-\tT")
  })
})

describe("verify input", () => {
  test("an unreadable input file is a usage error, not a store error", async () => {
    const f = failure(await run(verifyFile(join(dir, "missing.md"))))
    expect(f?.tag).toBe("UserError")
    expect(f?.message).toContain("cannot read")
  })
})

test("item files without overrides still load", async () => {
  expect(Option.isSome(await ok(readItem(ATTENTION)))).toBe(true)
  expect("overrides" in (await stored(ATTENTION))).toBe(false)
})
