import { BunServices } from "@effect/platform-bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock, TestConsole } from "effect/testing"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import crossref from "./fixtures/crossref-numpy.json" with { type: "json" }
import datacite from "./fixtures/datacite-arxiv.json" with { type: "json" }
import pubmed from "./fixtures/pubmed-29618526.json" with { type: "json" }
import { checkTitle, cslType, type Fetched, fetchCsl, normalizeCsl, parseId, RawCsl } from "../src/resolve.ts"
import { addEntries, createCollection, deleteItem, mergeEntries, moveEntry, readCollection, removeEntries, sortEntries, writeCollection } from "../src/collections.ts"
import { citationKeys, dossier, exportRows, isChinese, renderBibtex, renderList } from "../src/export.ts"
import { findCandidates } from "../src/find.ts"
import { type Collection, type Csl, IdentifierNotFoundError, type Item } from "../src/schema.ts"
import { compareEntry, contextAt, extractIds, judgeEntry, sameJournal, textEvidence, verifyFile } from "../src/verify.ts"
import { addNote, fileName, findItem, findStore, itemKey, keyFromFileName, matchesQuery, readItem, readItems, upsertItem, writeItem } from "../src/store.ts"
import { checkTitles, handle, report } from "../src/ui.ts"

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
    expect(ok("pmc:PMC5938574")).toEqual({ scheme: "pmc", pmc: "5938574" })
    expect(ok("pmc:5938574")).toEqual({ scheme: "pmc", pmc: "5938574" })
  })
  test("rejects junk before any network call", () => {
    for (const s of ["foo:bar", "pmid:12a", "pmc:PMCx", "doi:11.1/x", "arxiv:nope", "https://example.com/10.1/x", "Attention is all you need"]) {
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
  test("pmc: numeric id on the PMC endpoint, keyed by the record's DOI", async () => {
    let url = ""
    const layer = Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) => {
      url = request.url
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(pubmed))))
    }))
    const exit = await Effect.runPromiseExit(parseId("pmc:PMC5938574").pipe(Effect.flatMap(fetchCsl), Effect.provide(layer)))
    expect(url).toBe("https://pmc.ncbi.nlm.nih.gov/api/ctxp/v1/pmc/?format=csl&id=5938574")
    expect(Exit.isSuccess(exit) && itemKey(exit.value.canonical, "pmc:5938574")).toBe("doi:10.1098/rsif.2017.0387")
    expect(Exit.isSuccess(exit) && exit.value.verification.source).toBe("pmc")
  })
})

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

describe("store", () => {
  const dir = mkdtempSync(join(tmpdir(), "ibid-test-"))
  process.env.IBID_DIR = dir
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

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

describe("store discovery", () => {
  const base = mkdtempSync(join(tmpdir(), "ibid-find-"))
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const find = (cwd: string, env: Record<string, string>) => ok(findStore(cwd, env))

  test("IBID_DIR, then nearest ancestor .ibid, then the XDG global store", async () => {
    mkdirSync(join(base, "proj", ".ibid"), { recursive: true })
    mkdirSync(join(base, "proj", "a", "b"), { recursive: true })
    mkdirSync(join(base, "elsewhere"))
    const xdg = { XDG_DATA_HOME: join(base, "xdg") }
    expect(await find(join(base, "proj", "a", "b"), { ...xdg, IBID_DIR: join(base, "custom") })).toEqual({ root: join(base, "custom"), rule: "IBID_DIR" })
    expect(await find(join(base, "proj", "a", "b"), xdg)).toEqual({ root: join(base, "proj", ".ibid"), rule: "ancestor" })
    expect(await find(join(base, "proj"), xdg)).toEqual({ root: join(base, "proj", ".ibid"), rule: "ancestor" })
    expect(await find(join(base, "elsewhere"), xdg)).toEqual({ root: join(base, "xdg", "ibid"), rule: "global" })
    expect(await find(join(base, "elsewhere"), { HOME: join(base, "home") })).toEqual({ root: join(base, "home", ".local", "share", "ibid"), rule: "global" })
  })
})

describe("library", () => {
  const dir = mkdtempSync(join(tmpdir(), "ibid-lib-"))
  beforeAll(() => {
    process.env.IBID_DIR = dir
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const numpy = normalize(crossref) // 2020, Harris
  const deep = normalize(pubmed) // 2018, Ching, PMID 29618526
  const attention = normalize(datacite) // 2017, Vaswani
  const ids = { numpy: itemKey(numpy, ""), deep: itemKey(deep, ""), attention: itemKey(attention, "") }

  test("Stage 1 item files (no tags, no language) still load", async () => {
    const stage1 = {
      id: "pmid:1",
      canonical: { type: "article-journal", title: "Old" },
      verification: { source: "pubmed", url: "u", fetchedAt: "t", sha256: "h", titleMatch: "UNCHECKED" },
      evidences: []
    }
    mkdirSync(join(dir, "items"), { recursive: true })
    writeFileSync(join(dir, "items", fileName("pmid:1")), JSON.stringify(stage1))
    const item = Option.getOrThrow(await ok(readItem("pmid:1")))
    expect(item.tags).toEqual([])
    expect(item.canonical.language).toBeUndefined()
  })

  test("language is captured from the registry", () => {
    expect(normalize({ ...crossref, language: " en " }).language).toBe("en")
  })

  test("tags are sorted, unique and survive a re-add", async () => {
    const item = await ok(upsertItem(ids.numpy, fetched(numpy, "t1")))
    expect((await ok(writeItem({ ...item, tags: ["zeta", "alpha", "zeta"] }))).tags).toEqual(["alpha", "zeta"])
    expect((await ok(upsertItem(ids.numpy, fetched(numpy, "t2")))).tags).toEqual(["alpha", "zeta"])
  })

  test("note appends and keeps foreign evidence entries verbatim", async () => {
    const foreign = { kind: "undermind", match: 0.9, nested: [1, { x: null }] }
    const item = await ok(writeItem({ ...(await ok(findItem(ids.numpy))), evidences: [foreign, "bare string"] }))
    const saved = await ok(addNote(item, "NumPy is the base", "my reading"))
    expect(saved.evidences.slice(0, 2)).toEqual([foreign, "bare string"])
    expect(saved.evidences[2]).toMatchObject({ text: "NumPy is the base", source: "my reading" })
    expect((await ok(findItem(ids.numpy))).evidences).toEqual(saved.evidences)
  })

  test("findItem: a PMID finds an item keyed by DOI", async () => {
    await ok(upsertItem(ids.deep, fetched(deep, "t1")))
    await ok(upsertItem(ids.attention, fetched(attention, "t1")))
    expect((await ok(findItem("pmid:29618526"))).id).toBe(ids.deep)
    expect((await ok(findItem("pmc:PMC5938574"))).id).toBe(ids.deep)
    expect(errorTag(await run(findItem("pmid:42")))).toBe("IdentifierNotFoundError")
  })

  test("readItems reads only the given keys and skips missing ones", async () => {
    const found = await ok(readItems([ids.numpy, "doi:10.1/absent", ids.numpy]))
    expect([...found.keys()]).toEqual([ids.numpy])
  })

  test("ls query: every word, case-insensitive, across fields", async () => {
    const item = await ok(findItem(ids.numpy))
    expect(matchesQuery(item, [])).toBe(true)
    expect(matchesQuery(item, ["HARRIS", "numpy", "2020", "nature"])).toBe(true)
    expect(matchesQuery(item, ["alpha"])).toBe(true) // tag
    expect(matchesQuery(item, ["s41586"])).toBe(true) // id
    expect(matchesQuery(item, ["numpy", "vaswani"])).toBe(false)
  })

  const col = (itemIds: Array<string>): Collection => ({ name: "t", createdAt: "x", entries: itemIds.map((itemId) => ({ itemId })) })
  const order = (c: Collection) => c.entries.map((e) => e.itemId)

  test("col add: no duplicates, context update, --at", () => {
    const add = (c: Collection, xs: Array<string>, o?: Parameters<typeof addEntries>[2]) => Effect.runSync(addEntries(c, xs, o))
    const r = add(col(["a", "b"]), ["b", "c", "c"])
    expect(order(r.col)).toEqual(["a", "b", "c"])
    expect([...r.actions]).toEqual([["b", "unchanged"], ["c", "added"]])
    const u = add(r.col, ["a"], { context: "Slide 3" })
    expect(u.col.entries[0]).toEqual({ itemId: "a", context: "Slide 3" })
    expect(u.actions.get("a")).toBe("updated")
    expect(order(add(r.col, ["x", "y", "a"], { at: 2 }).col)).toEqual(["a", "x", "y", "b", "c"])
    expect(errorTag(Effect.runSyncExit(addEntries(r.col, ["x"], { at: 5 })))).toBe("CollectionError")
  })

  test("col rm by position and by id, move, sort, merge", async () => {
    const c = col([ids.numpy, ids.deep, ids.attention, "pmid:1"])
    expect(order(await ok(removeEntries(c, ["1", "pmid:29618526"])))).toEqual([ids.attention, "pmid:1"])
    expect(errorTag(await run(removeEntries(c, ["9"])))).toBe("CollectionError")
    expect(order(await ok(moveEntry(c, "arxiv:1706.03762", 1)))).toEqual([ids.attention, ids.numpy, ids.deep, "pmid:1"])
    expect(order(await ok(moveEntry(c, "1", 4)))).toEqual([ids.deep, ids.attention, "pmid:1", ids.numpy])

    const items = new Map<string, Item>()
    for (const id of Object.values(ids)) items.set(id, await ok(findItem(id)))
    // pmid:1 is not in the map: last either way.
    expect(order(sortEntries(c, items, "year"))).toEqual([ids.attention, ids.deep, ids.numpy, "pmid:1"])
    expect(order(sortEntries(c, items, "year", true))).toEqual([ids.numpy, ids.deep, ids.attention, "pmid:1"])
    expect(order(sortEntries(c, items, "author"))).toEqual([ids.deep, ids.numpy, ids.attention, "pmid:1"])
    expect(order(sortEntries(c, items, "title"))).toEqual([ids.numpy, ids.attention, ids.deep, "pmid:1"])

    const merged = mergeEntries(col(["a", "b"]), [col(["b", "c"]), { ...col(["d", "c"]), entries: [{ itemId: "d", section: "Intro" }, { itemId: "c" }] }])
    expect(merged.entries).toEqual([{ itemId: "a" }, { itemId: "b" }, { itemId: "c" }, { itemId: "d", section: "Intro" }])
  })

  test("invalid collection names are rejected", async () => {
    for (const name of ["Deck", "-x", "a/b", "../x", "", "a b"]) {
      expect(errorTag(await run(createCollection(name)))).toBe("CollectionError")
    }
    expect((await ok(createCollection("q4-deck.v2", "Q4"))).title).toBe("Q4")
    expect(errorTag(await run(createCollection("q4-deck.v2")))).toBe("CollectionError")
  })

  test("rm refuses a referenced item; --force removes it from collections", async () => {
    await ok(createCollection("deck"))
    await ok(writeCollection({ ...(await ok(readCollection("deck"))), entries: [{ itemId: ids.attention }, { itemId: ids.numpy }] }))
    const refused = await run(deleteItem("arxiv:1706.03762", false))
    expect(errorTag(refused)).toBe("ItemReferencedError")
    expect(Exit.isFailure(refused) && String(Option.getOrUndefined(Exit.findErrorOption(refused))?.message)).toContain("deck")
    expect(Option.isSome(await ok(readItem(ids.attention)))).toBe(true)

    expect(await ok(deleteItem("arxiv:1706.03762", true))).toEqual({ id: ids.attention, removedFrom: ["deck"] })
    expect(Option.isNone(await ok(readItem(ids.attention)))).toBe(true)
    expect(order(await ok(readCollection("deck")))).toEqual([ids.numpy])
  })
})

describe("export rendering", () => {
  const numpy = normalize(crossref)
  const attention = normalize(datacite)
  const zh: Csl = {
    type: "article-journal",
    title: "采用网络编码的广播传输效率分析",
    author: [{ family: "崔", given: "巍" }, { family: "王", given: "伟" }, { family: "李", given: "四" }, { family: "张", given: "三" }],
    issued: { "date-parts": [[2011]] },
    "container-title": "计算机工程",
    volume: "37"
  }

  test("language per entry: et al. for English, 等 for Chinese, in one GB/T list", async () => {
    expect(isChinese(zh)).toBe(true)
    expect(isChinese({ ...numpy, language: "zh-CN" })).toBe(true)
    expect(isChinese(numpy)).toBe(false)
    const [en, cn] = await renderList([attention, zh], "gb7714", "text")
    expect(en).toStartWith("[1] VASWANI A, SHAZEER N, PARMAR N, et al.")
    expect(en).toContain("et al.")
    expect(cn).toStartWith("[2] 崔巍, 王伟, 李四, 等.")
  })

  test("English styles stay English for a Chinese entry; a DOI replaces the registry URL", async () => {
    const [natureZh] = await renderList([zh], "nature", "text")
    expect(natureZh).toContain("(2011).")
    expect(natureZh).not.toContain("年")
    const [withUrl] = await renderList([{ ...numpy, URL: "http://dx.doi.org/10.1038/s41586-020-2649-2" }], "gb7714", "text")
    expect(withUrl).toContain("DOI:10.1038/s41586-020-2649-2")
    expect(withUrl).not.toContain("http")
    const [noDoi] = await renderList([{ ...zh, URL: "https://example.org/paper" }], "gb7714", "text")
    expect(noDoi).toContain("https://example.org/paper")
  })

  test("numeric styles are numbered by position; APA keeps the given order", async () => {
    expect((await renderList([attention, numpy], "vancouver", "text")).map((l) => l.slice(0, 10))).toEqual(["1. Vaswani", "2. Harris "])
    const apa = await renderList([numpy, attention], "apa", "text")
    expect(apa[0]).toStartWith("Harris")
    expect(apa[1]).toStartWith("Vaswani")
  })

  test("Markdown keeps the style's italics and bold, decodes entities", async () => {
    const [md] = await renderList([{ ...numpy, author: attention.author!, title: "Array programming with <i>NumPy</i> & friends" }], "nature", "md")
    expect(md).toBe("1. Vaswani, A. *et al.* Array programming with *NumPy* & friends. *Nature* **585**, 357–362 (2020).")
  })

  test("BibTeX keeps Chinese text; keys are ASCII, unique and do not depend on the rest of the list", async () => {
    const zh2: Csl = { ...zh, title: "另一篇", DOI: "10.3969/x" }
    const zhKey = citationKeys([zh])[0]!
    expect(zhKey).toMatch(/^ref2011[0-9a-f]{6}$/)
    const zh2Key = citationKeys([zh2])[0]!
    expect(citationKeys([zh2, numpy, zh])).toEqual([zh2Key, "harris2020array", zhKey])
    expect(zh2Key).not.toBe(zhKey)
    // Colliding Latin keys all get the item's hash, whatever the order.
    const other = { ...numpy, DOI: "10.1/other" }
    const [a, b] = citationKeys([numpy, other]) as [string, string]
    expect(a).toMatch(/^harris2020array[0-9a-f]{6}$/)
    expect(citationKeys([other, numpy])).toEqual([b, a])
    expect(new Set(citationKeys([numpy, numpy])).size).toBe(2)

    const bib = await renderBibtex([zh, numpy, attention])
    expect(bib).toContain(`@article{${zhKey},`)
    expect(bib).toContain("title = {采用网络编码的广播传输效率分析}")
    expect(bib).toContain("journal = {计算机工程}")
    expect(bib).toContain("@article{harris2020array,")
    expect(bib).toContain("journal = {arXiv preprint arXiv:1706.03762}")
  })

  test("one batch per list: APA disambiguates the same author and year", async () => {
    const second = { ...numpy, title: "Another paper", DOI: "10.1/other" }
    const apa = await renderList([numpy, second], "apa", "text")
    // citeproc letters them in bibliography (title) order; the list keeps ours.
    expect(apa[0]).toStartWith("Harris, C. R., & Millman, K. J. (2020b). Array programming")
    expect(apa[1]).toStartWith("Harris, C. R., & Millman, K. J. (2020a). Another paper")
  })

  test("GB/T: language groups merged back in order and renumbered", async () => {
    const lines = await renderList([zh, attention, { ...zh, title: "另一篇" }, numpy], "gb7714", "text")
    expect(lines.map((l) => l.slice(0, 4))).toEqual(["[1] ", "[2] ", "[3] ", "[4] "])
    expect(lines[1]).toContain("VASWANI A, SHAZEER N, PARMAR N, et al.")
    expect(lines[2]).toStartWith("[3] 崔巍, 王伟, 李四, 等. 另一篇")
    expect(lines[3]).toContain("HARRIS")
  })

  test("article number becomes the page; editor, ISBN, place and series are kept", async () => {
    const { page: _page, ...noPage } = crossref
    const c = normalize({
      ...noPage,
      "article-number": "5416",
      editor: [{ family: "Doe", given: "J" }],
      ISBN: "978-0-00-000000-0",
      "publisher-place": " London ",
      "collection-title": ["Lecture Notes"]
    })
    expect(c).toMatchObject({ page: "5416", "article-number": "5416", editor: [{ family: "Doe", given: "J" }], ISBN: ["978-0-00-000000-0"], "collection-title": "Lecture Notes" })
    // PubMed reports the journal's country as the place; it is kept only off journal articles.
    expect(c["publisher-place"]).toBeUndefined()
    expect(normalize({ ...crossref, type: "book-chapter", "publisher-place": " London " })["publisher-place"]).toBe("London")
    expect(normalize({ ...crossref, "article-number": "e1" }).page).toBe("357-362")
    const [line] = await renderList([c], "vancouver", "text")
    expect(line).toContain("5416")
  })

  test("dossier escapes pipes and newlines and links by DOI, else PMID", () => {
    const item = (canonical: Csl, evidences: Array<unknown> = []): Item => ({
      id: "x",
      canonical,
      verification: { source: "doi.org", url: "u", fetchedAt: "t", sha256: "h", titleMatch: "UNCHECKED" },
      evidences,
      tags: []
    })
    const table = dossier([
      { item: item({ ...numpy, title: "A | B" }, [{ text: "x | y" }, { kind: "foreign" }]), context: "Slide 3\nleft", section: "Intro" },
      { item: item({ type: "article-journal", title: "T", PMID: "123" }) }
    ]).split("\n")
    expect(table[2]).toBe("| 1 | Harris et al., 2020 | A \\| B | section: Intro; context: Slide 3<br>left; x \\| y | [doi:10.1038/s41586-020-2649-2](https://doi.org/10.1038/s41586-020-2649-2) |")
    expect(table[3]).toBe("| 2 | -, n.d. | T |  | [PMID 123](https://pubmed.ncbi.nlm.nih.gov/123/) |")
  })
})

describe("verify (pure)", () => {
  test("identifiers from prose: trailing punctuation, duplicates, line numbers", () => {
    const text = [
      "See https://doi.org/10.1038/S41586-020-2649-2).",
      "Again (doi:10.1038/s41586-020-2649-2), and [x](https://doi.org/10.1002/(sici)1097-4636(199711)36:2<123::aid>3.0.co;2-x).",
      "",
      "PMID: 29618526; arXiv:1706.03762v2, doi 10.48550/arXiv.1706.03762."
    ].join("\n")
    expect(extractIds(text).map(({ id, line }) => [id, line])).toEqual([
      ["doi:10.1038/S41586-020-2649-2", 1],
      ["doi:10.1002/(sici)1097-4636(199711)36:2<123::aid>3.0.co;2-x", 2],
      ["pmid:29618526", 4],
      ["arxiv:1706.03762v2", 4]
    ])
  })

  test("identifiers in Markdown links, angle brackets and SICI DOIs", () => {
    const ids = (s: string) => extractIds(s).map((f) => f.id)
    // The link form `export --format dossier` prints.
    expect(ids("[doi:10.1038/s41586-020-2649-2](https://doi.org/10.1038/s41586-020-2649-2)")).toEqual(["doi:10.1038/s41586-020-2649-2"])
    expect(ids("[NumPy](https://doi.org/10.1038/s41586-020-2649-2), see <https://doi.org/10.1098/rsif.2017.0387>.")).toEqual([
      "doi:10.1038/s41586-020-2649-2",
      "doi:10.1098/rsif.2017.0387"
    ])
    expect(ids("doi:10.1002/(sici)1097-4636(199711)36:2<123::aid-jbm1>3.0.co;2-x.")).toEqual(["doi:10.1002/(sici)1097-4636(199711)36:2<123::aid-jbm1>3.0.co;2-x"])
    expect(ids(`<a href="x">10.1234/abc</a>`)).toEqual(["doi:10.1234/abc"])
    // A link's text and its target are read separately, so a target that differs is not hidden.
    expect(ids("[doi:10.1038/s41586-020-2649-2](https://doi.org/10.1038/FAKE-DOI)")).toEqual(["doi:10.1038/s41586-020-2649-2", "doi:10.1038/FAKE-DOI"])
    expect(ids("[1](https://doi.org/10.1000/a),[2](https://doi.org/10.1000/b)")).toEqual(["doi:10.1000/a", "doi:10.1000/b"])
    // Full-width punctuation and Chinese text end a DOI; a full-width colon after PMID is accepted.
    expect(ids("正如崔巍（2011年）（doi:10.3969/j.issn.1000-3428.2011.01.001）所述。PMID：29618526")).toEqual(["doi:10.3969/j.issn.1000-3428.2011.01.001", "pmid:29618526"])
  })

  const ching = normalize(pubmed) // Ching 2018
  const harris = normalize(crossref) // Harris 2020
  const attention = normalize(datacite) // Vaswani 2017

  test("context is the list item in a list, else the paragraph", () => {
    const text = [
      "Intro line.",
      "",
      "1. Harris CR. Array programming with NumPy. Nature. 2020.",
      "   doi:10.1098/rsif.2017.0387",
      "2. Ching T. Opportunities and obstacles for deep learning in biology and medicine. 2018. doi:10.1038/s41586-020-2649-2",
      "- [3] bullet",
      "",
      "Prose that",
      "spans lines."
    ].join("\n")
    expect(contextAt(text, 4)).toBe("1. Harris CR. Array programming with NumPy. Nature. 2020.\n   doi:10.1098/rsif.2017.0387")
    expect(contextAt(text, 5)).toStartWith("2. Ching T.")
    expect(contextAt(text, 5)).not.toContain("bullet")
    expect(contextAt(text, 9)).toBe("Prose that\nspans lines.")
    const table = "| # | Title | Link |\n| --- | --- | --- |\n| 1 | A | doi:10.1000/a |\n| 2 | B | doi:10.1000/b |"
    expect(contextAt(table, 3)).toBe("| 1 | A | doi:10.1000/a |")
    // Swapped DOIs: each entry's registry record matches nothing in its own item.
    expect(textEvidence(ching, contextAt(text, 4))).toBeUndefined()
    expect(textEvidence(harris, contextAt(text, 5))).toBeUndefined()
    expect(textEvidence(harris, contextAt(text, 3))).toBe("title found")
    // Once per context: a DOI cited earlier is still judged inside the list item.
    expect(extractIds(`See doi:10.1038/s41586-020-2649-2.\n\n${text}`).map((f) => [f.key, f.line])).toEqual([
      ["doi:10.1038/s41586-020-2649-2", 1],
      ["doi:10.1098/rsif.2017.0387", 6],
      ["doi:10.1038/s41586-020-2649-2", 7]
    ])
  })

  test("text evidence: fuzzy title, else first author and year", () => {
    expect(textEvidence(ching, "Opportunities and obstacle for deep learning in biology and medicine (2018)")).toMatch(/^title found \(similarity 0\.9\d+\)$/)
    expect(textEvidence(attention, "As Vaswani et al. (2017) (doi:10.48550/arXiv.1706.03762) showed")).toBe("first author Vaswani and year 2017 found")
    expect(textEvidence(attention, "As Vaswani et al. (2019) showed")).toBeUndefined()

    // Two works cited in one sentence: author and year only count next to their own identifier.
    const evidence = (prose: string) => extractIds(prose).map((f) => textEvidence(f.key.includes("arxiv") ? attention : ching, f.near))
    expect(evidence("Vaswani et al. 2017 (doi:10.48550/arXiv.1706.03762) and Ching et al. 2018 (doi:10.1098/rsif.2017.0387) agree."))
      .toEqual(["first author Vaswani and year 2017 found", "first author Ching and year 2018 found"])
    expect(evidence("Vaswani et al. 2017 (doi:10.1098/rsif.2017.0387) and Ching et al. 2018 (doi:10.48550/arXiv.1706.03762) agree."))
      .toEqual([undefined, undefined])
  })

  test("several identifiers in one context: only the text before each one vouches for it", () => {
    const evidence = (text: string) => extractIds(text).map((f) => textEvidence(f.key.includes("rsif") ? ching : harris, f.near))
    const refs = (a: string, b: string) =>
      `Harris, C. R. (2020). Array programming with NumPy. Nature. https://doi.org/${a}\nChing, T. (2018). Opportunities and obstacles for deep learning in biology and medicine. https://doi.org/${b}`
    expect(evidence(refs("10.1038/s41586-020-2649-2", "10.1098/rsif.2017.0387"))).toEqual(["title found", "title found"])
    // Unmarked reference lines form one paragraph; the other entry's title must not count.
    expect(evidence(refs("10.1098/rsif.2017.0387", "10.1038/s41586-020-2649-2"))).toEqual([undefined, undefined])
  })

  test("Chinese text: names and titles match as substrings, and 年 after the year is fine", () => {
    const zh: Csl = { type: "article-journal", title: "采用网络编码的广播传输效率分析", author: [{ literal: "崔巍" }], issued: { "date-parts": [[2011]] } }
    expect(textEvidence(zh, "正如崔巍等（2011）所述")).toBe("first author 崔巍 and year 2011 found")
    expect(textEvidence(zh, "崔巍等2011年的研究")).toBe("first author 崔巍 and year 2011 found")
    expect(textEvidence(zh, "论文采用网络编码的广播传输效率分析指出")).toBe("title found")
    expect(textEvidence(zh, "崔巍等（2012）所述")).toBeUndefined()
  })

  test("journal abbreviations", () => {
    expect(sameJournal("J R Soc Interface", "Journal of the Royal Society Interface")).toBe(true)
    expect(sameJournal("Nat. Commun.", "Nature Communications")).toBe(true)
    expect(sameJournal("Phys Rev Lett", "Physical Review Letters")).toBe(true)
    expect(sameJournal("Science", "Nature")).toBe(false)
    expect(sameJournal("Nature", "Nature Communications")).toBe(false)
    expect(sameJournal("PNAS", "Proceedings of the National Academy of Sciences")).toBe(true)
    expect(sameJournal("NEJM", "New England Journal of Medicine")).toBe(true)
    expect(sameJournal("Journal of the Royal Society Interface", "J R Soc Interface")).toBe(true)
    expect(sameJournal("PNAS", "Physical Review Letters")).toBe(false)
  })

  test(".bib judgement: MISMATCH over CHECK over OK", () => {
    const full = { title: "Array programming with NumPy", author: [{ family: "Harris" }], issued: { "date-parts": [[2020]] } }
    expect(judgeEntry({ ...full, "container-title": "Nature" }, harris)).toEqual({ status: "OK", details: "Array programming with NumPy" })
    expect(judgeEntry({ ...full, "container-title": "Science" }, harris)).toEqual({ status: "MISMATCH", details: "journal: \"Science\" vs registry \"Nature\"" })
    expect(judgeEntry({ DOI: "10.1038/s41586-020-2649-2" }, harris)).toEqual({ status: "CHECK", details: "entry lacks title, author, year" })
    const fake = { title: attention.title, author: [{ family: "Vaswani" }], issued: { "date-parts": [[2017]] }, "container-title": "Nature", volume: "585", page: "100--120" }
    expect(judgeEntry(fake, attention)).toEqual({
      status: "CHECK",
      details: "journal: \"Nature\" not in the registry record; volume: \"585\" not in the registry record; page: \"100\" not in the registry record"
    })
    expect(judgeEntry({ ...fake, issued: { "date-parts": [[2016]] } }, attention).status).toBe("MISMATCH")
    // The usual ways of writing a journal for an arXiv preprint are conventions, not claims.
    const preprint = { title: attention.title, author: [{ family: "Vaswani" }], issued: { "date-parts": [[2017]] } }
    expect(judgeEntry({ ...preprint, "container-title": "arXiv preprint arXiv:1706.03762" }, attention).status).toBe("OK")
    expect(judgeEntry({ ...preprint, "container-title": "CoRR", volume: "abs/1706.03762" }, attention).status).toBe("OK")
  })

  const registry = normalize(crossref)
  test(".bib comparison: OK, title mismatch, year mismatch", () => {
    expect(compareEntry({ title: "Array programming with NumPy", author: [{ family: "Harris" }], issued: { "date-parts": [[2020]] }, volume: "585", issue: "7825", page: "357-362" }, registry)).toEqual([])
    expect(compareEntry({ title: "Attention is all you need", issued: { "date-parts": [[2020]] } }, registry)).toEqual([
      { field: "title", claimed: "Attention is all you need", registry: "Array programming with NumPy" }
    ])
    expect(compareEntry({ title: "Array programming with NumPy", issued: { "date-parts": [[2019]] } }, registry)).toEqual([
      { field: "year", claimed: "2019", registry: "2020" }
    ])
  })
})

describe("find and verify with a stubbed HttpClient", () => {
  const dir = mkdtempSync(join(tmpdir(), "ibid-net-"))
  beforeAll(() => {
    process.env.IBID_DIR = dir
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const urls: Array<string> = []
  const stub = (status: number, body: unknown) =>
    Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) => {
      urls.push(request.url + "?" + new URLSearchParams(request.urlParams as any).toString())
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })))
    }))
  const works = {
    results: [
      { id: "W1", doi: "https://doi.org/10.1/a", title: "Attention is all you need in speech separation", publication_year: 2021, authorships: [{ author: { display_name: "Cem Subakan" } }] },
      { id: "W2", doi: "https://doi.org/10.48550/ARXIV.1706.03762", title: "Attention Is All You Need", publication_year: 2017, authorships: [{ author: { display_name: "Ashish Vaswani" } }] },
      { id: "W3", doi: null, title: "Attention is all you need?", publication_year: null, authorships: [] }
    ]
  }

  test("find ranks by title similarity and filters by author family name", async () => {
    const all = await ok(Effect.provide(findCandidates("Attention, is all | you need", { rows: 3 }), stub(200, works)))
    expect(all.map((c) => c.openalex)).toEqual(["W2", "W3", "W1"])
    expect(all[0]).toMatchObject({ similarity: 1, doi: "10.48550/arxiv.1706.03762", year: 2017, firstAuthor: "Ashish Vaswani" })
    expect(urls.at(-1)).toContain("filter=title.search%3Aattention+is+all+you+need")
    const byAuthor = await ok(Effect.provide(findCandidates("Attention is all you need", { author: "vaswani" }), stub(200, works)))
    expect(byAuthor.map((c) => c.openalex)).toEqual(["W2"])
  })

  test("find falls back to the general search when the title filter finds nothing", async () => {
    const calls: Array<string> = []
    const layer = Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) => {
      const viaFilter = new URLSearchParams(request.urlParams as any).has("filter")
      calls.push(viaFilter ? "filter" : "search")
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(viaFilter ? { results: [] } : works))))
    }))
    const found = await ok(Effect.provide(findCandidates("attention all you need transformer paper"), layer))
    expect(calls).toEqual(["filter", "search"])
    expect(found.length).toBe(3)
    expect(found[0]?.openalex).toBe("W2")
  })

  test("find: 429 mentions OPENALEX_API_KEY and is not retried", async () => {
    const before = urls.length
    const exit = await run(Effect.provide(findCandidates("x y"), stub(429, { error: "Rate limit exceeded" })))
    expect(Exit.isFailure(exit) && Option.getOrUndefined(Exit.findErrorOption(exit))?.message).toContain("OPENALEX_API_KEY")
    expect(urls.length - before).toBe(1)
  })

  test("verify reports NOT_FOUND for an identifier the registry does not know", async () => {
    const md = join(dir, "draft.md")
    writeFileSync(md, "Claimed in doi:10.1038/missing.\n")
    const findings = await ok(Effect.provide(verifyFile(md), stub(404, "nope")))
    expect(findings).toEqual([{ status: "NOT_FOUND", location: "line 1", id: "doi:10.1038/missing", details: "doi:10.1038/missing: not found at doi.org" }])
  })

  test("verify: a DOI followed by the PMID of the same work shares the text before the DOI", async () => {
    const md = join(dir, "refs.md")
    writeFileSync(md, "Harris CR, et al. Array programming with NumPy. Nature. 2020. doi:10.1038/s41586-020-2649-2 PMID: 32939066\n")
    const findings = await ok(Effect.provide(verifyFile(md), stub(200, crossref)))
    expect(findings.map((f) => [f.id, f.status])).toEqual([["doi:10.1038/s41586-020-2649-2", "OK"], ["pmid:32939066", "OK"]])
  })
})

describe("CLI contracts", () => {
  const withConsole = <A, E>(e: Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.gen(function*() {
      const exit = yield* Effect.exit(e)
      return { exit, out: yield* TestConsole.logLines, err: yield* TestConsole.errorLines }
    }).pipe(Effect.provide(TestConsole.layer)))
  const notFound = new IdentifierNotFoundError({ id: "doi:10.1/x", message: "doi:10.1/x: not in local store" })

  test("--json failure: one {error} value on stdout, nothing on stderr, a silent failure", async () => {
    const r = await withConsole(handle(() => Effect.fail(notFound))({ json: true }))
    expect(r.out.map((l) => JSON.parse(String(l)))).toEqual([{ error: { _tag: "IdentifierNotFoundError", id: "doi:10.1/x", message: "doi:10.1/x: not in local store" } }])
    expect(r.err).toEqual([])
    expect(errorTag(r.exit)).toBe("Reported")
    // Without --json it stays a text error for Command.run to render.
    expect(errorTag((await withConsole(handle(() => Effect.fail(notFound))({ json: false }))).exit)).toBe("UserError")
  })

  test("--json batch failure: only the array", async () => {
    const results = [{ input: "foo:bar", ok: false as const, error: notFound }]
    const r = await withConsole(handle(() => report(results, true, () => ""))({ json: true }))
    expect(r.out.length).toBe(1)
    expect(JSON.parse(String(r.out[0]))[0].error._tag).toBe("IdentifierNotFoundError")
    expect(r.err).toEqual([])
    expect(errorTag(r.exit)).toBe("Reported")
  })

  test("--expect-title: none, or once per id", () => {
    expect(Effect.runSync(checkTitles(["a", "b"], []))).toBeUndefined()
    expect(Effect.runSync(checkTitles(["a", "b"], ["A", "B"]))).toEqual(["A", "B"])
    expect(errorTag(Effect.runSyncExit(checkTitles(["a", "b"], ["A"])))).toBe("UserError")
  })

  test("a registry that never answers times out as an UpstreamError", async () => {
    const hang = Layer.succeed(HttpClient.HttpClient)(HttpClient.make(() => Effect.never))
    const exit = await Effect.runPromise(Effect.gen(function*() {
      const fiber = yield* parseId("doi:10.1234/slow").pipe(Effect.flatMap(fetchCsl), Effect.provide(hang), Effect.forkChild)
      yield* TestClock.adjust("21 seconds")
      return yield* Fiber.await(fiber)
    }).pipe(Effect.provide(TestClock.layer())))
    expect(errorTag(exit)).toBe("UpstreamError")
    expect(Exit.isFailure(exit) && Option.getOrUndefined(Exit.findErrorOption(exit))?.message).toContain("no response within 20 s")
  })
})

describe("export rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "ibid-export-"))
  beforeAll(() => {
    process.env.IBID_DIR = dir
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("collection order, numbered by position; a missing item is an error naming it", async () => {
    const numpy = normalize(crossref)
    const attention = normalize(datacite)
    await ok(upsertItem(itemKey(numpy, ""), fetched(numpy, "t")))
    await ok(upsertItem(itemKey(attention, ""), fetched(attention, "t")))
    await ok(createCollection("deck"))
    const deck = await ok(readCollection("deck"))
    await ok(writeCollection({ ...deck, entries: [{ itemId: itemKey(attention, ""), context: "Slide 1" }, { itemId: itemKey(numpy, "") }] }))
    const rows = await ok(exportRows("deck"))
    expect(rows[0]).toMatchObject({ context: "Slide 1" })
    const lines = await renderList(rows.map((r) => r.item.canonical), "nature", "text")
    expect(lines.map((l) => l.slice(0, 11))).toEqual(["1. Vaswani,", "2. Harris, "])
    expect((await ok(exportRows(undefined))).map((r) => r.item.id)).toEqual([itemKey(numpy, ""), itemKey(attention, "")])

    await ok(writeCollection({ ...deck, entries: [{ itemId: itemKey(numpy, "") }, { itemId: "doi:10.1/gone" }] }))
    const exit = await run(exportRows("deck"))
    expect(Exit.isFailure(exit) && Option.getOrUndefined(Exit.findErrorOption(exit))?.message).toContain("[2] doi:10.1/gone")
  })
})
