import { BunServices } from "@effect/platform-bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import crossref from "./fixtures/crossref-numpy.json" with { type: "json" }
import { cleanText } from "../src/clean.ts"
import { checkTitle, normalizeCsl, RawCsl } from "../src/resolve.ts"
import { type Csl, Item } from "../src/schema.ts"
import { compareEntry, missingDetails, sameJournal, textEvidence, unidentifiedItems, extractIds, verifyFile } from "../src/verify.ts"

const normalize = (raw: unknown) => normalizeCsl(Schema.decodeUnknownSync(RawCsl)(raw))

// Shapes of live Crossref records (checked 2026-11-06), trimmed to the fields that matter.
const gseapy = normalize({
  type: "journal-article",
  title: "GSEApy: a comprehensive package for performing gene set enrichment analysis in Python",
  author: [{ family: "Fang", given: "Zhuoqing" }],
  editor: [{ family: "Lu", given: "Zhiyong" }],
  "container-title": "Bioinformatics",
  issued: { "date-parts": [[2022, 11, 25]] },
  "published-print": { "date-parts": [[2023, 1, 1]] },
  "journal-issue": { issue: "1", "published-print": { "date-parts": [[2023, 1, 1]] } },
  volume: "39",
  issue: "1",
  "article-number": "btac757",
  DOI: "10.1093/bioinformatics/btac757"
})
const antiox = normalize({
  type: "journal-article",
  title: "Transcriptional Regulation of ROS Homeostasis by the ERR Subfamily of Nuclear Receptors",
  author: [{ family: "Vernier", given: "M" }],
  "container-title": "Antioxidants",
  issued: { "date-parts": [[2021, 3, 12]] },
  "journal-issue": { issue: "3" },
  volume: "10",
  issue: "3",
  page: "437",
  DOI: "10.3390/antiox10030437"
})

describe("normalization at ingestion", () => {
  test("year from the print date; the online year kept when it differs", () => {
    expect(gseapy.issued).toEqual({ "date-parts": [[2023, 1, 1]] })
    expect(gseapy["issued-online"]).toEqual({ "date-parts": [[2022, 11, 25]] })
    // journal-issue's print date when there is no published-print.
    const issueOnly = normalize({ title: "T", issued: { "date-parts": [[2022, 12]] }, "journal-issue": { "published-print": { "date-parts": [[2023, 2]] } } })
    expect(issueOnly.issued).toEqual({ "date-parts": [[2023, 2]] })
    // An online-only issue: the issue's date (Heart Fail Rev 29(1), online 2023-12-16, issue 2024-01).
    const online = normalize({ title: "T", issued: { "date-parts": [[2023, 12, 16]] }, "journal-issue": { "published-online": { "date-parts": [[2024, 1]] } } })
    expect(online.issued).toEqual({ "date-parts": [[2024, 1]] })
    expect(online["issued-online"]).toEqual({ "date-parts": [[2023, 12, 16]] })
    // Same year: the print date, nothing extra stored.
    const same = normalize({ title: "T", issued: { "date-parts": [[2023, 6, 30]] }, "published-print": { "date-parts": [[2023, 10]] } })
    expect(same).toEqual({ type: "document", title: "T", issued: { "date-parts": [[2023, 10]] } })
    // No print date: the earliest date, as before.
    expect(antiox.issued).toEqual({ "date-parts": [[2021, 3, 12]] })
    expect(antiox["issued-online"]).toBeUndefined()
  })

  test("entities decoded and markup reduced in every text field", () => {
    const c = normalize({
      type: "journal-article",
      title: "The <scp>DNA</scp> of <jats:italic>E. coli</jats:italic>, H<sub>2</sub>O &amp; CO<jats:sub>2</jats:sub> at p &lt; 0.05",
      "container-title": "Molecular &amp; Cellular Proteomics",
      author: [{ family: "M&#252;ller", given: "A" }],
      publisher: "Smith &amp; Sons"
    })
    expect(c.title).toBe("The DNA of <i>E. coli</i>, H<sub>2</sub>O & CO<sub>2</sub> at p < 0.05")
    expect(c["container-title"]).toBe("Molecular & Cellular Proteomics")
    expect(c.author).toEqual([{ family: "Müller", given: "A" }])
    expect(c.publisher).toBe("Smith & Sons")
    expect(cleanText("<em>a</em> <strong>b</strong> <jats:bold>c</jats:bold> <sup>d</sup> <span class=\"x\">e</span>")).toBe("<i>a</i> <b>b</b> <b>c</b> <sup>d</sup> e")
  })

  test("no editor on journal articles", () => {
    expect(gseapy.editor).toBeUndefined()
  })

  test("publisher-location is the place", () => {
    const book = normalize({ type: "book", title: "Biomechanics", subtitle: [], "publisher-location": "New York, NY", publisher: "Springer New York" })
    expect(book["publisher-place"]).toBe("New York, NY")
    expect(book.title).toBe("Biomechanics")
  })

  test("subtitle joined unless the title already has it", () => {
    const raw = { type: "journal-article", title: "Effects of Long-term Vitamin E Supplementation on Cardiovascular Events and Cancer", subtitle: ["A Randomized Controlled Trial"] }
    expect(normalize(raw).title).toBe("Effects of Long-term Vitamin E Supplementation on Cardiovascular Events and Cancer: A Randomized Controlled Trial")
    expect(normalize({ ...raw, title: `${raw.title}: a randomized controlled trial` }).title).toBe(`${raw.title}: a randomized controlled trial`)
    expect(normalize({ ...raw, title: "Why?" }).title).toBe("Why? A Randomized Controlled Trial")
  })

  test("item files written before this change still load", () => {
    const old = { id: "doi:x", canonical: { type: "article-journal", title: "T", issued: { "date-parts": [[2020]] } }, verification: { source: "doi.org", url: "u", fetchedAt: "t", sha256: "h", titleMatch: "UNCHECKED" }, evidences: [] }
    const item = Schema.decodeUnknownSync(Item)(old)
    expect("canonical" in item && item.canonical.title).toBe("T")
  })
})

describe("comparison rules", () => {
  test("either year is accepted, in .bib and in author-and-year evidence", () => {
    const entry = (y: number) => ({ title: gseapy.title, issued: { "date-parts": [[y]] } })
    expect(compareEntry(entry(2023), gseapy)).toEqual([])
    expect(compareEntry(entry(2022), gseapy)).toEqual([])
    expect(compareEntry(entry(2021), gseapy)).toEqual([{ field: "year", claimed: "2021", registry: "2023" }])
    expect(textEvidence(gseapy, "as Fang et al. (2022) showed")).toBe("first author Fang and year 2022 found")
    expect(textEvidence(gseapy, "as Fang et al. (2023) showed")).toBe("first author Fang and year 2023 found")
    expect(textEvidence(gseapy, "as Fang et al. (2021) showed")).toBeUndefined()
  })

  test("journal names: parentheses and `et` dropped, otherwise strict", () => {
    expect(sameJournal("Antioxidants (Basel)", "Antioxidants")).toBe(true)
    expect(sameJournal("Biochim Biophys Acta Mol Basis Dis", "Biochimica et Biophysica Acta (BBA) - Molecular Basis of Disease")).toBe(true)
    expect(sameJournal("Mol Cell Proteomics", "Molecular &amp; Cellular Proteomics")).toBe(true)
    expect(sameJournal("J Am Coll Cardiol", "JACC")).toBe(true)
    expect(sameJournal("Nature", "Nature Communications")).toBe(false)
    expect(sameJournal("J Am Chem Soc", "JACC")).toBe(false)
    expect(sameJournal("Nat Rev", "Nature Reviews Cardiology")).toBe(false)
    expect(sameJournal("Biochim Biophys Acta", "Biochimica et Biophysica Acta (BBA) - Molecular Basis of Disease")).toBe(false)
    expect(sameJournal("Biochim Biophys Acta Mol Cell Res", "Biochimica et Biophysica Acta (BBA) - Molecular Basis of Disease")).toBe(false)
  })

  test("main title against title with subtitle is FUZZY_MATCH", () => {
    const run = (expected: string, actual: string) => Effect.runSyncExit(checkTitle(expected, actual))
    const exit = run("Biomechanics: Mechanical Properties of Living Tissues", "Biomechanics")
    expect(Exit.isSuccess(exit) && exit.value.titleMatch).toBe("FUZZY_MATCH")
    const other = run("Effects of Long-term Vitamin E Supplementation on Cardiovascular Events and Cancer", "Effects of Long-term Vitamin E Supplementation on Cardiovascular Events and Cancer: A Randomized Controlled Trial")
    expect(Exit.isSuccess(other) && other.value.titleMatch).toBe("FUZZY_MATCH")
    // A main title under 10 characters, or a different one, is still a mismatch.
    expect(Exit.isFailure(run("Cells: A Review of Everything Known", "Cells"))).toBe(true)
    expect(Exit.isFailure(run("Biomechanics: Mechanical Properties of Living Tissues", "Biophysics"))).toBe(true)
    // In a .bib entry too.
    expect(compareEntry({ title: "Biomechanics - Mechanical Properties of Living Tissues" }, { type: "book", title: "Biomechanics" })).toEqual([])
  })

  test("a leading e on a first page is ignored", () => {
    const adhm: Csl = { type: "article-journal", title: "T", page: "2301006", "article-number": "2301006" }
    expect(compareEntry({ page: "e2301006" }, adhm)).toEqual([])
    expect(compareEntry({ page: "2301006" }, { ...adhm, page: "e2301006" })).toEqual([])
    expect(compareEntry({ page: "e2301007" }, adhm)).toEqual([{ field: "page", claimed: "2301007", registry: "2301006" }])
  })
})

describe("plain-text reference entries", () => {
  test("details: year, volume and first page or article number must appear", () => {
    expect(missingDetails(antiox, "Vernier M. Transcriptional regulation... Antioxidants (Basel). 2021;10(3):. doi:10.3390/antiox10030437")).toEqual(["page or article number 437"])
    expect(missingDetails(antiox, "Antioxidants (Basel). 2021;10(3):437. doi:10.3390/antiox10030437")).toEqual([])
    expect(missingDetails(antiox, "Antioxidants. 2020;(3):437.")).toEqual(["year 2021", "volume 10"])
    // The DOI's own `btac757` does not count; either year does.
    expect(missingDetails(gseapy, "Bioinformatics. 2023;39(1). doi:10.1093/bioinformatics/btac757")).toEqual(["page or article number btac757"])
    expect(missingDetails(gseapy, "Bioinformatics. 2022;39(1):btac757.")).toEqual([])
    expect(missingDetails({ type: "article-journal", title: "T", issued: { "date-parts": [[2005]] }, volume: "353", page: "2057-2062" }, "N Engl J Med. 2005;353:2057-62.")).toEqual([])
    expect(missingDetails({ type: "article-journal", title: "T", page: "2301006" }, "Adv Healthc Mater. 2023;12(27):e2301006.")).toEqual([])
    // gb7714-2025 prints a preprint's year right after `arXiv`; only `arXiv:<id>` is an identifier.
    expect(missingDetails({ type: "article", title: "T", issued: { "date-parts": [[2017]] } }, "T[PP/OL]. arXiv（2017）. DOI:10.48550/arxiv.1706.03762.")).toEqual([])
    expect(missingDetails({ type: "article", title: "T", issued: { "date-parts": [[2017]] } }, "T. arXiv:2017.01234")).toEqual(["year 2017"])
    // Nothing to check when the registry has none of them.
    expect(missingDetails({ type: "book", title: "Biomechanics" }, "Fung YC. Biomechanics.")).toEqual([])
  })

  test("main title found counts as title evidence", () => {
    const jama: Csl = { type: "article-journal", title: "Effects of Long-term Vitamin E Supplementation on Cardiovascular Events and Cancer: A Randomized Controlled Trial" }
    expect(textEvidence(jama, "Effects of long-term vitamin E supplementation on cardiovascular events and cancer. JAMA. 2005")).toBe("main title found")
  })

  test("list items without an identifier in a mostly identified list", () => {
    const text = [
      "Intro.",
      "",
      "1. A. One. doi:10.1000/a",
      "2. B. Two, no identifier here.",
      "",
      "3. C. Three. doi:10.1000/c",
      "4. D. Four.",
      "   doi:10.1000/d",
      "",
      "Some paragraph.",
      "",
      "- just a bullet",
      "- another bullet"
    ].join("\n")
    expect(unidentifiedItems(text, extractIds(text))).toEqual([
      { line: 4, finding: { status: "UNIDENTIFIED", location: "line 4", details: "no identifier: B. Two, no identifier here." } }
    ])
  })

  const dir = mkdtempSync(join(tmpdir(), "ibid-acc-"))
  beforeAll(() => { process.env.IBID_DIR = dir })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const stub = Layer.mergeAll(
    BunServices.layer,
    Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(crossref), { status: 200 })))
    ))
  )
  const verify = (name: string, text: string) => {
    writeFileSync(join(dir, name), text)
    return Effect.runPromise(Effect.provide(verifyFile(join(dir, name)), stub))
  }

  test("verify: an entry with an empty locator is CHECK, an unidentified item is listed, prose is untouched", async () => {
    const findings = await verify("refs.md", [
      "As Harris et al. (2020) showed (doi:10.1038/s41586-020-2649-2).",
      "",
      "1. Harris CR, et al. Array programming with NumPy. Nature. 2020;585(7825):. doi:10.1038/s41586-020-2649-2",
      "2. Somebody. A paper with no identifier. J Things. 2019;1:1-2.",
      "3. Harris CR, et al. Array programming with NumPy. Nature. 2020;585(7825):357-62. doi:10.1038/s41586-020-2649-2"
    ].join("\n"))
    expect(findings.map((f) => [f.status, f.location])).toEqual([["OK", "line 1"], ["CHECK", "line 3"], ["UNIDENTIFIED", "line 4"], ["OK", "line 5"]])
    expect(findings[1]!.details).toBe("title found, but the entry lacks the registry's page or article number 357: Array programming with NumPy")
  })
})
