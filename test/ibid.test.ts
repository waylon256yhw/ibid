import { BunServices } from "@effect/platform-bun"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import crossref from "./fixtures/crossref-numpy.json" with { type: "json" }
import datacite from "./fixtures/datacite-arxiv.json" with { type: "json" }
import pubmed from "./fixtures/pubmed-29618526.json" with { type: "json" }
import { checkTitle, cslType, type Fetched, fetchCsl, normalizeCsl, parseId, RawCsl } from "../src/resolve.ts"
import { fileName, itemKey, keyFromFileName, readItem, upsertItem } from "../src/store.ts"

const normalize = (raw: unknown) => normalizeCsl(Schema.decodeUnknownSync(RawCsl)(raw))
const errorTag = <E extends { _tag: string }>(exit: Exit.Exit<unknown, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit))?._tag : undefined

describe("parseId", () => {
  const ok = (s: string) => Effect.runSync(parseId(s))
  test("accepted forms", () => {
    expect(ok("doi:10.1038/S41586-020-2649-2")).toEqual({ scheme: "doi", doi: "10.1038/s41586-020-2649-2" })
    expect(ok("10.1038/s41586-020-2649-2")).toEqual({ scheme: "doi", doi: "10.1038/s41586-020-2649-2" })
    expect(ok("https://doi.org/10.1038/s41586-020-2649-2")).toEqual({ scheme: "doi", doi: "10.1038/s41586-020-2649-2" })
    expect(ok("pmid:29618526")).toEqual({ scheme: "pmid", pmid: "29618526" })
    expect(ok("arxiv:1706.03762v7")).toEqual({ scheme: "doi", doi: "10.48550/arxiv.1706.03762" })
    expect(ok("arXiv:hep-th/9901001")).toEqual({ scheme: "doi", doi: "10.48550/arxiv.hep-th/9901001" })
  })
  test("rejects junk before any network call", () => {
    for (const s of ["foo:bar", "pmid:12a", "doi:11.1/x", "arxiv:nope", "https://example.com/10.1/x", "Attention is all you need"]) {
      expect(errorTag(Effect.runSyncExit(parseId(s)))).toBe("InvalidIdentifierError")
    }
  })
})

describe("filenames", () => {
  test("round trip", () => {
    for (const key of ["doi:10.1038/s41586-020-2649-2", "doi:10.1002/(sici)1097-4636(199711)36:2<123::aid>3.0.co;2-x", "pmid:29618526"]) {
      expect(keyFromFileName(fileName(key))).toBe(key)
    }
    expect(fileName("doi:10.1038/s41586-020-2649-2")).toBe("doi_10.1038%2Fs41586-020-2649-2.json")
  })
})

describe("title check", () => {
  const run = (expected: string | undefined, actual: string) => Effect.runSyncExit(checkTitle(expected, actual))
  test("VERIFIED after normalization", () => {
    expect(run("attention is ALL you need!", "<i>Attention</i> Is All You Need")).toEqual(
      Exit.succeed({ titleMatch: "VERIFIED", expectedTitle: "attention is ALL you need!", similarity: 1 })
    )
    expect(Exit.isSuccess(run("Résumé of Ångström", "Resume of Angstrom"))).toBe(true)
  })
  test("FUZZY_MATCH near the original", () => {
    const exit = run("Opportunities and obstacle for deep learning in biology and medicine", pubmed.title)
    expect(Exit.isSuccess(exit) && exit.value.titleMatch).toBe("FUZZY_MATCH")
  })
  test("mismatch fails", () => {
    expect(errorTag(run("Attention is all you need", "Array programming with NumPy"))).toBe("TitleMismatchError")
  })
  test("no expectation is UNCHECKED", () => {
    expect(run(undefined, "x")).toEqual(Exit.succeed({ titleMatch: "UNCHECKED" }))
  })
})

describe("normalizeCsl", () => {
  test("crossref: type mapped, non-CSL fields dropped", () => {
    const c = normalize(crossref)
    expect(c.type).toBe("article-journal")
    expect(c.author?.[0]).toEqual({ family: "Harris", given: "Charles R." })
    expect(c.ISSN).toEqual(["0028-0836", "1476-4687"])
    expect(Object.keys(c)).not.toContain("license")
    expect(Object.keys(c)).not.toContain("reference-count")
    expect(itemKey(c, "x")).toBe("doi:10.1038/s41586-020-2649-2")
  })
  test("datacite: DOI lower-cased, article kept", () => {
    const c = normalize(datacite)
    expect(c.DOI).toBe("10.48550/arxiv.1706.03762")
    expect(c.type).toBe("article")
    expect(c.issued).toEqual({ "date-parts": [[2017]] })
  })
  test("pubmed record is keyed by its DOI", () => {
    const c = normalize(pubmed)
    expect(c.PMCID).toBe("PMC5938574")
    expect(c.ISSN).toEqual(["1742-5662"])
    expect(itemKey(c, "pmid:29618526")).toBe("doi:10.1098/rsif.2017.0387")
  })
  test("odd shapes", () => {
    const c = normalize({
      type: "something-new",
      title: ["  A <i>Drosophila</i>\n study "],
      author: [{ literal: "WHO" }, { name: "CERN" }, { family: "Doe", given: "J" }],
      issued: { "date-parts": [["2019", "03"]] },
      volume: 7,
      PMID: 123
    })
    expect(c).toEqual({
      type: "document",
      title: "A <i>Drosophila</i> study",
      author: [{ literal: "WHO" }, { literal: "CERN" }, { family: "Doe", given: "J" }],
      issued: { "date-parts": [[2019, 3]] },
      volume: "7",
      PMID: "123"
    })
    expect(itemKey(c, "x")).toBe("pmid:123")
    expect(cslType("proceedings-article")).toBe("paper-conference")
  })
})

describe("fetchCsl with a stubbed HttpClient", () => {
  const stub = (status: number, body: unknown) =>
    Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })))
    ))
  const run = (status: number, body: unknown, id: string) =>
    Effect.runPromiseExit(parseId(id).pipe(Effect.flatMap(fetchCsl), Effect.provide(stub(status, body))))

  test("success", async () => {
    const exit = await run(200, crossref, "doi:10.1038/s41586-020-2649-2")
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.canonical.title).toBe("Array programming with NumPy")
      expect(exit.value.verification.source).toBe("doi.org")
      expect(exit.value.verification.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
  test("404 is IdentifierNotFoundError", async () => {
    expect(errorTag(await run(404, "nope", "doi:10.1038/missing"))).toBe("IdentifierNotFoundError")
  })
  test("pubmed empty array is IdentifierNotFoundError", async () => {
    expect(errorTag(await run(200, [], "pmid:99999999999"))).toBe("IdentifierNotFoundError")
  })
})

describe("store", () => {
  const dir = mkdtempSync(join(tmpdir(), "ibid-test-"))
  process.env.IBID_DIR = dir
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromiseExit(Effect.provide(e, BunServices.layer) as Effect.Effect<A, E>)
  const ok = async <A, E>(e: Effect.Effect<A, E, any>) => {
    const exit = await run(e)
    if (!Exit.isSuccess(exit)) throw new Error(String(exit.cause))
    return exit.value
  }
  const fetched = (canonical: Fetched["canonical"], fetchedAt: string): Fetched => ({
    canonical,
    verification: { source: "doi.org", url: "u", fetchedAt, sha256: "h" }
  })

  test("re-add refreshes canonical but keeps evidences verbatim", async () => {
    const canonical = normalize(crossref)
    const id = "doi:10.1038/s41586-020-2649-2"
    await ok(upsertItem(id, fetched(canonical, "t1")))

    const path = join(dir, "items", fileName(id))
    const evidence = { kind: "note", text: "keep me", nested: { score: 0.93, tags: ["a"] } }
    const onDisk = JSON.parse(readFileSync(path, "utf8"))
    writeFileSync(path, JSON.stringify({ ...onDisk, evidences: [evidence] }))

    const item = await ok(upsertItem(id, fetched({ ...canonical, volume: "999" }, "t2")))
    expect(item.evidences).toEqual([evidence])
    expect(item.canonical.volume).toBe("999")
    expect(item.verification.fetchedAt).toBe("t2")
    expect(item.verification.titleMatch).toBe("UNCHECKED")
    expect(Option.getOrThrow(await ok(readItem(id)))).toEqual(item)
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true)
  })

  test("re-add keeps the verified title expectation and PubMed ids", async () => {
    const fromPubmed = normalize(pubmed)
    const { PMCID: _c, PMID: _p, ...fromDoiOrg } = fromPubmed
    const id = itemKey(fromPubmed, "x")
    const path = join(dir, "items", fileName(id))

    expect((await ok(upsertItem(id, fetched(fromPubmed, "t1"), pubmed.title))).verification.titleMatch).toBe("VERIFIED")

    // Same paper refreshed from doi.org, no --expect-title this time.
    const again = await ok(upsertItem(id, fetched(fromDoiOrg, "t2")))
    expect(again.verification).toMatchObject({ fetchedAt: "t2", titleMatch: "VERIFIED", expectedTitle: pubmed.title })
    expect(again.canonical.PMID).toBe("29618526")
    expect(again.canonical.PMCID).toBe("PMC5938574")

    // The registry title no longer matches what was verified: refuse, and leave the file alone.
    const before = readFileSync(path, "utf8")
    expect(errorTag(await run(upsertItem(id, fetched({ ...fromDoiOrg, title: "Something else entirely" }, "t3"))))).toBe("TitleMismatchError")
    expect(readFileSync(path, "utf8")).toBe(before)
  })
})
