import { BunServices } from "@effect/platform-bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { TestClock, TestConsole } from "effect/testing"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import crossref from "./fixtures/crossref-numpy.json" with { type: "json" }
import datacite from "./fixtures/datacite-arxiv.json" with { type: "json" }
import { briefAuthor, briefVenue, citeLib, type CslStyle, isNumeric, parentOf, render, renderBrief, renderList, resolveStyle, sortsEntries } from "../src/export.ts"
import { normalizeCsl, RawCsl } from "../src/resolve.ts"
import type { Csl, Item } from "../src/schema.ts"

const normalize = (raw: unknown) => normalizeCsl(Schema.decodeUnknownSync(RawCsl)(raw))
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

const builtin = async (name: string) => (await citeLib()).plugins.config.get("@csl").styles.get(name) as string
const REPO = "https://raw.githubusercontent.com/citation-style-language"
const dependent = (parent: string, locale = "en-US") =>
  `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" default-locale="${locale}">
  <info>
    <title>Journal of Tests</title>
    <link href="http://www.zotero.org/styles/journal-of-tests" rel="self"/>
    <link href="http://www.zotero.org/styles/${parent}" rel="independent-parent"/>
    <category citation-format="numeric"/>
  </info>
</style>`

const dir = mkdtempSync(join(tmpdir(), "ibid-styles-"))
beforeAll(() => {
  process.env.IBID_DIR = dir
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Serves `files` by URL (404 otherwise) and records every request. */
const repo = (files: Record<string, string>, urls: Array<string>) =>
  Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) => {
    urls.push(request.url)
    const body = files[request.url]
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body ?? "404: Not Found", { status: body === undefined ? 404 : 200 })))
  }))
const resolve = (input: string, layer: Layer.Layer<HttpClient.HttpClient>) =>
  Effect.runPromise(Effect.gen(function*() {
    const exit = yield* Effect.exit(resolveStyle(input))
    return { exit, err: yield* TestConsole.errorLines }
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, layer, TestConsole.layer))))
const failure = (exit: Exit.Exit<unknown, unknown>) => {
  const e = Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) as any : undefined
  return e && String(e.userMessage ?? e.message)
}
const value = <A>(exit: Exit.Exit<A, unknown>) => {
  if (!Exit.isSuccess(exit)) throw new Error(String(exit.cause))
  return exit.value
}

describe("--style resolution", () => {
  test("a repository name is lower-case letters, digits and hyphens; checked before any request", async () => {
    const urls: Array<string> = []
    for (const bad of ["../etc/passwd", "Nature", "apa 7th", "a/b", "-x", "x.y"]) {
      const { exit } = await resolve(bad, repo({}, urls))
      expect(failure(exit)).toContain("not a valid repository name")
    }
    expect(urls).toEqual([])
  })

  test("top level, then dependent/; a dependent style renders with its parent; both are cached", async () => {
    const parent = await builtin("vancouver")
    const urls: Array<string> = []
    const files = {
      [`${REPO}/styles/master/dependent/journal-of-tests.csl`]: dependent("test-parent"),
      [`${REPO}/styles/master/test-parent.csl`]: parent
    }
    const style = value((await resolve("journal-of-tests", repo(files, urls))).exit) as CslStyle
    expect(urls).toEqual([
      `${REPO}/styles/master/journal-of-tests.csl`,
      `${REPO}/styles/master/dependent/journal-of-tests.csl`,
      `${REPO}/styles/master/test-parent.csl`
    ])
    expect(style).toEqual({ name: "test-parent", xml: parent })
    expect(existsSync(join(dir, "styles", "journal-of-tests.csl"))).toBe(true)
    expect(existsSync(join(dir, "styles", "test-parent.csl"))).toBe(true)

    // Second use: from the cache, no request.
    const again: Array<string> = []
    expect(value((await resolve("journal-of-tests", repo({}, again))).exit)).toEqual(style)
    expect(again).toEqual([])
    const [line] = await renderList([attention], style, "text")
    expect(line).toStartWith("1. Vaswani A")
  })

  test("unknown name, a missing parent, and no network without a cache fail in one line", async () => {
    expect(failure((await resolve("no-such-style", repo({}, []))).exit)).toBe(
      "style no-such-style: not a built-in style, a .csl file or a style in the CSL repository"
    )
    const orphan = { [`${REPO}/styles/master/orphan.csl`]: dependent("gone-parent") }
    expect(failure((await resolve("orphan", repo(orphan, []))).exit)).toBe("style orphan: parent style gone-parent not found")
    const offline = Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) =>
      Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "getaddrinfo ENOTFOUND" }) }))
    ))
    const message = failure((await resolve("offline-style", offline)).exit)!
    expect(message).toStartWith("style offline-style: cannot fetch from the CSL repository (")
    expect(message).toEndWith(") and no cached copy")
    expect(message).not.toContain("\n")

    const stalled = Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(new ReadableStream({ start() {} }), { status: 200 })))
    ))
    const timedOut = await Effect.runPromise(Effect.gen(function*() {
      const fiber = yield* resolveStyle("stalled-style").pipe(Effect.provide(Layer.mergeAll(BunServices.layer, stalled)), Effect.forkChild)
      yield* TestClock.adjust("21 seconds")
      return yield* Fiber.await(fiber)
    }).pipe(Effect.provide(TestClock.layer())))
    expect(failure(timedOut)).toBe("style stalled-style: cannot fetch from the CSL repository (no response within 20 s) and no cached copy")
  })

  test("a path to a local .csl file; built-in names stay built in", async () => {
    const file = join(dir, "my style.csl")
    writeFileSync(file, await builtin("apa"))
    const urls: Array<string> = []
    const style = value((await resolve(file, repo({}, urls))).exit) as CslStyle
    expect(style.name).toBe(`file:${file}`)
    expect(urls).toEqual([])
    expect(value((await resolve("gb7714", repo({}, urls))).exit)).toBe("gb7714")
    writeFileSync(join(dir, "junk.csl"), "hello")
    expect(failure((await resolve(join(dir, "junk.csl"), repo({}, urls))).exit)).toContain("not a CSL style")
  })

  test("a missing locale is fetched and cached; when it cannot be, en-US with a note on stderr", async () => {
    const parent = (await builtin("apa")).replace("<style ", `<style default-locale="xx-YY" `)
    const files = { [`${REPO}/styles/master/locale-test.csl`]: parent }
    const urls: Array<string> = []
    const { err, exit } = await resolve("locale-test", repo(files, urls))
    expect(urls.at(-1)).toBe(`${REPO}/locales/master/locales-xx-YY.xml`)
    expect(err).toEqual(["note: locale xx-YY not found in the CSL repository; rendering in en-US"])
    const [line] = await renderList([numpy], value(exit) as CslStyle, "text")
    expect(line).toContain("Harris, C. R.")

    const localeXml = (await citeLib()).plugins.config.get("@csl").locales.get("en-US")
    const withLocale = { [`${REPO}/styles/master/locale-test-2.csl`]: parent.replace("xx-YY", "en-ZZ"), [`${REPO}/locales/master/locales-en-ZZ.xml`]: localeXml }
    expect((await resolve("locale-test-2", repo(withLocale, []))).err).toEqual([])
    expect(existsSync(join(dir, "styles", "locales-en-ZZ.xml"))).toBe(true)
  })
})

describe("order", () => {
  test("numeric or not comes from the style's category; the parent link is read in either attribute order", async () => {
    expect(isNumeric(await builtin("vancouver"))).toBe(true)
    expect(isNumeric(await builtin("nature"))).toBe(true)
    expect(isNumeric(await builtin("apa"))).toBe(false)
    expect(isNumeric(await builtin("harvard1"))).toBe(false)
    expect(parentOf(dependent("apa"))).toBe("apa")
    expect(parentOf(`<link rel="independent-parent" href="http://www.zotero.org/styles/elsevier-harvard"/>`)).toBe("elsevier-harvard")
    expect(parentOf(await builtin("apa"))).toBeUndefined()
  })

  test("author-date follows the style's sort, so 2020a comes before 2020b; --keep-order keeps ours", async () => {
    const second = { ...numpy, title: "Another paper", DOI: "10.1/other" }
    const sorted = await renderList([attention, numpy, second], "apa", "text")
    expect(sorted.map((l) => l.slice(0, 40))).toEqual([
      "Harris, C. R., & Millman, K. J. (2020a).",
      "Harris, C. R., & Millman, K. J. (2020b).",
      "Vaswani, A., Shazeer, N., Parmar, N., Us"
    ])
    expect(sorted[0]).toContain("Another paper")
    const kept = await renderList([attention, numpy, second], "apa", "text", true)
    expect(kept[0]).toStartWith("Vaswani")
    expect(kept[1]).toStartWith("Harris, C. R., & Millman, K. J. (2020b). Array programming")
    // Numeric styles ignore the flag's absence: always collection order.
    expect((await renderList([numpy, attention], "nature", "text")).map((l) => l.slice(0, 9))).toEqual(["1. Harris", "2. Vaswan"])
  })
})

describe("rich output", () => {
  const item = (canonical: Csl): Item => ({
    id: "x",
    canonical,
    verification: { source: "doi.org", url: "u", fetchedAt: "t", sha256: "h", titleMatch: "UNCHECKED" },
    evidences: [],
    tags: []
  })
  const rows = [zh, attention, { ...zh, title: "另一篇" }, numpy].map((canonical) => ({ item: item(canonical) }))
  const italic = { ...numpy, title: "Array programming with <i>NumPy</i>", URL: "http://dx.doi.org/10.1038/s41586-020-2649-2" }

  test("HTML keeps italics and Chinese, hangs non-numeric entries, aligns numbers by position", async () => {
    const apa = await render([{ item: item(italic) }, { item: item(zh) }], "html", "apa")
    expect(apa).toStartWith(`<meta charset="utf-8">\n<div class="csl-bib-body">\n<p style="margin:0 0 0 2em;text-indent:-2em">`)
    expect(apa).toContain("with <i>NumPy</i>")
    expect(apa).toContain("<i>Nature</i>")
    expect(apa).toContain("采用网络编码的广播传输效率分析")
    expect(apa).not.toContain("dx.doi.org")

    const gb = (await render(rows, "html", "gb7714")).split("\n").filter((l) => l.startsWith("<p"))
    expect(gb.map((l) => /min-width:2.5em">(.*?) <\/span>/.exec(l)?.[1])).toEqual(["[1]", "[2]", "[3]", "[4]"])
    expect(gb[0]).toContain("崔巍, 王伟, 李四, 等")
    expect(gb[1]).toContain("et al.")
    const [nature] = await renderList([italic], "nature", "html")
    expect(nature).toContain("<i>NumPy</i>")
    expect(nature).toContain("<b>585</b>")
  })

  test("RTF is one document that keeps italics and Chinese (as \\u escapes), numbered by position", async () => {
    const doc = await render(rows, "rtf", "gb7714")
    expect(doc).toStartWith("{\\rtf1\\ansi")
    expect(doc).toEndWith("}")
    // Balanced braces outside escapes.
    let depth = 0
    for (const ch of doc.replace(/\\[\\{}]/g, "")) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0
    expect(depth).toBe(0)
    const paras = doc.split("\n").filter((l) => l.startsWith("\\pard"))
    expect(paras.map((p) => /^\\pard\\li720\\fi-720\\tx720\\sa120 (\[\d\])\\tab/.exec(p)?.[1])).toEqual(["[1]", "[2]", "[3]", "[4]"])
    expect(paras[0]).toContain(`\\u${"崔".charCodeAt(0)}{}`)
    expect(paras[2]).toContain(`\\u${"另".charCodeAt(0)}{}`)
    expect(doc).not.toMatch(/[^\x00-\x7f]/)

    const apa = await render([{ item: item(italic) }, { item: item(zh) }], "rtf", "apa")
    expect(apa).toContain("{\\i{}NumPy}")
    expect(apa).toContain("{\\i{}Nature}")
    expect(apa).toContain(`\\u${"采".charCodeAt(0)}{}`)
  })

  test("Markdown and text still render; a bilingual non-numeric list puts the Chinese group first", async () => {
    const zhAuthorDate: CslStyle = { name: "test-zh-author-date", xml: (await builtin("apa")).replace("<style ", `<style default-locale="zh-CN" `) }
    const lines = await renderList([attention, zh, numpy], zhAuthorDate, "md")
    expect(lines[0]).toStartWith("崔巍")
    expect(lines[1]).toStartWith("Harris")
    expect(lines[2]).toStartWith("Vaswani")
    expect((await renderList([attention, zh, numpy], zhAuthorDate, "md", true))[0]).toStartWith("Vaswani")
  })
})

describe("brief slide citations", () => {
  const item = (canonical: Csl): Item => ({
    id: "x",
    canonical,
    verification: { source: "doi.org", url: "u", fetchedAt: "t", sha256: "h", titleMatch: "UNCHECKED" },
    evidences: [],
    tags: []
  })

  test("author and venue slots: 1, 2 and 3+ authors in English and Chinese; venue fallback chain", () => {
    const one: Csl = { type: "article-journal", title: "Relativity", author: [{ family: "Einstein", given: "A." }], "container-title-short": "Ann. Phys.", "container-title": "Annalen der Physik", issued: { "date-parts": [[1905]] } }
    const three: Csl = { ...numpy, author: [...numpy.author!, { family: "van der Walt", given: "S. J." }] }
    const zh1: Csl = { type: "article-journal", title: "中文一", author: [{ family: "王", given: "五" }], "container-title": "中国科学", issued: { "date-parts": [[2023]] } }
    const zh2: Csl = { type: "article-journal", title: "中文二", author: [{ family: "张", given: "三" }, { literal: "李四" }], "container-title": "计算机学报", issued: { "date-parts": [[2024]] } }
    const book: Csl = { type: "book", title: "Biomechanics", author: [{ family: "Fung" }], publisher: "Springer", issued: { "date-parts": [[1993]] } }
    const bare: Csl = { type: "document", title: "Note" }

    expect(renderBrief([one, numpy, three, attention, zh1, zh2, zh, book, bare], "md")).toEqual([
      "Einstein, *Ann. Phys.*, 1905",
      "Harris & Millman, *Nature*, 2020",
      "Harris et al., *Nature*, 2020",
      "Vaswani et al., *arXiv*, 2017",
      "王五, *中国科学*, 2023",
      "张三, 李四, *计算机学报*, 2024",
      "崔巍 等, *计算机工程*, 2011",
      "Fung, *Springer*, 1993",
      "n.d."
    ])
    expect(briefAuthor(bare)).toBeUndefined()
    expect(briefVenue({ type: "chapter", title: "Ch", "collection-title": "LNCS", publisher: "Springer" })).toBe("LNCS")
  })

  test("works as --style brief / brief-num across md, text, html, rtf and as --format brief, keeping collection order", async () => {
    expect(await sortsEntries("brief")).toBe(false)
    expect(await sortsEntries("brief-num")).toBe(false)
    expect(await sortsEntries("apa")).toBe(true)
    expect(await sortsEntries("vancouver")).toBe(false)

    const manual: Item = { id: "manual:0123456789", manual: "Doe J. Internal slide deck; 2022.", evidences: [], tags: [] }
    const rows = [{ item: item(attention) }, { item: manual }, { item: item(numpy) }]

    expect(await render(rows, "brief", "vancouver")).toBe(
      "Vaswani et al., *arXiv*, 2017\nDoe J. Internal slide deck; 2022.\nHarris & Millman, *Nature*, 2020"
    )
    expect(await render(rows, "brief", "brief-num")).toBe(
      "[1] Vaswani et al., *arXiv*, 2017\n[2] Doe J. Internal slide deck; 2022.\n[3] Harris & Millman, *Nature*, 2020"
    )
    expect(await render(rows, "text", "brief")).toBe(
      "Vaswani et al., arXiv, 2017\nDoe J. Internal slide deck; 2022.\nHarris & Millman, Nature, 2020"
    )
    expect(await render(rows, "text", "brief-num")).toBe(
      "[1] Vaswani et al., arXiv, 2017\n[2] Doe J. Internal slide deck; 2022.\n[3] Harris & Millman, Nature, 2020"
    )
    const html = await render(rows, "html", "brief-num")
    expect(html).toContain(`<span style="display:inline-block;min-width:2.5em">[1] </span>Vaswani et al., <i>arXiv</i>, 2017</p>`)
    expect(html).toContain(`<span style="display:inline-block;min-width:2.5em">[2] </span>Doe J. Internal slide deck; 2022.</p>`)
    const rtf = await render([{ item: item(zh) }, { item: item(numpy) }], "rtf", "brief")
    expect(rtf).toContain(`{\\i{}\\uc0\\u-29791{}\\uc0\\u31639{}`)
    expect(rtf).toContain(`Harris & Millman, {\\i{}Nature}, 2020\\par`)
  })
})
