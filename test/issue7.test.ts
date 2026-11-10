import { BunServices } from "@effect/platform-bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render, renderBibtex } from "../src/export.ts"
import { findCandidates, findLine } from "../src/find.ts"
import type { RegistryItem } from "../src/schema.ts"
import { addManual, fileName, readItem, upsertItem, writeItem } from "../src/store.ts"
import { fetchAndStore, showLines } from "../src/ui.ts"
import { verifyFile } from "../src/verify.ts"

const dir = mkdtempSync(join(tmpdir(), "ibid-issue7-"))
const before = process.env.IBID_DIR
beforeAll(() => { process.env.IBID_DIR = dir })
afterAll(() => {
  if (before === undefined) delete process.env.IBID_DIR
  else process.env.IBID_DIR = before
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E, any>, reply: (url: string) => unknown = () => { throw new Error("unexpected network call") }) => {
  const services = Layer.mergeAll(BunServices.layer, Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) => {
    const url = new URL(request.url)
    for (const [k, v] of request.urlParams) url.searchParams.append(k, String(v))
    const body = reply(url.toString())
    return Effect.succeed(HttpClientResponse.fromWeb(request, body instanceof Response ? body : new Response(JSON.stringify(body))))
  })))
  return Effect.runPromise(Effect.provide(effect, services) as Effect.Effect<A, E>)
}
const paper = (suffix: string): RegistryItem => ({
  id: `doi:10.1000/${suffix}`,
  canonical: { type: "article-journal", title: "A reference with a complete title", DOI: `10.1000/${suffix}`,
    author: [{ family: "Doe", given: "J" }], issued: { "date-parts": [[2020]] }, "container-title": "Journal", volume: "3", page: "4-9" },
  verification: { source: "doi.org", url: "https://doi.org/test", fetchedAt: "t", sha256: "h", titleMatch: "UNCHECKED" },
  evidences: [{ nested: [1, 2] }], tags: ["keep"]
})
const manuscript = (name: string, text: string) => {
  const path = join(dir, name)
  writeFileSync(path, text)
  return verifyFile(path)
}
const cli = (...args: Array<string>) => {
  const result = Bun.spawnSync(["bun", "src/cli.ts", ...args], { cwd: join(import.meta.dir, ".."), env: { ...process.env, IBID_DIR: dir } })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe("structured verification and exact manual matching", () => {
  test("all-manual references, wrapped text, distinct lists restarting at one, and an unknown entry", async () => {
    const { item: a } = await run(addManual("Doe J. Internal report. Agency; 2020."))
    const { item: b } = await run(addManual("Li X. Another report. Agency; 2021."))
    const findings = await run(manuscript("manual.md", [
      "References", "1. Doe J. Internal report.", "   Agency; 2020.", "2. Li X. Another report. Agency; 2021.", "",
      "Supplementary References", "1. Doe J. Internal report. Agency; 2020.", "2. Unregistered report; 2022."
    ].join("\n")))
    expect(findings.filter((f) => f.matchedBy).map((f) => [f.itemId, f.line, f.entryNumber])).toEqual([
      [a.id, 2, 1], [b.id, 4, 2], [a.id, 7, 1]
    ])
    expect(findings[0]).toMatchObject({ status: "OK", text: "Doe J. Internal report.\n   Agency; 2020.", matchedBy: "manual-text" })
    expect(findings.find((f) => f.line === 8)).toMatchObject({ status: "UNIDENTIFIED", text: "Unregistered report; 2022." })
    expect(cli("verify", join(dir, "manual.md"), "--json").code).toBe(1)
    writeFileSync(join(dir, "accepted.md"), `References\n1. ${a.manual}\n`)
    expect(cli("verify", join(dir, "accepted.md"), "--json").code).toBe(0)
  })

  test("unknown references no longer require a majority of identifiers; ordinary bullets stay untouched", async () => {
    const item = paper("minority")
    await run(writeItem(item))
    const findings = await run(manuscript("minority.md", [
      "- buy milk", "- buy bread", "", "References",
      `1. Doe J. A reference with a complete title. Journal. 2020;3:4-9. doi:${item.canonical.DOI}`,
      "2. Unknown report.", "3. Another unknown report.", "4. Still unknown."
    ].join("\n")))
    expect(findings.filter((f) => f.status === "UNIDENTIFIED").map((f) => f.entryNumber)).toEqual([2, 3, 4])
    expect(findings.some((f) => f.text?.includes("buy milk"))).toBe(false)
  })

  test("unheaded prose lists do not produce UNIDENTIFIED or a failing exit code", async () => {
    const item = paper("body-list")
    await run(writeItem(item))
    const citation = `Doe 2020, doi:${item.canonical.DOI}`
    for (const [name, text] of [
      ["bullets", `- Use broadcasting (${citation})\n- Test float16 throughput\n- Update Friday slides`],
      ["steps", `Based on ${citation}.\n\n1. Prepare samples\n2. Run the experiment`],
      ["half", `- Use broadcasting (${citation})\n- Test float16 throughput`]
    ]) {
      const findings = await run(manuscript(`${name}.md`, text!))
      expect(findings.map((f) => f.status)).toEqual(["OK"])
      expect(cli("verify", join(dir, `${name}.md`), "--json").code).toBe(0)
    }
    const majority = await run(manuscript("unheaded-refs.md", `1. ${citation}\n2. ${citation}\n3. Unknown reference.`))
    expect(majority.filter((f) => f.status === "UNIDENTIFIED")).toMatchObject([{ entryNumber: 3 }])
  })

  test("manual BibTeX preserves literal backslashes, tildes and TeX symbols", async () => {
    for (const text of [
      String.raw`Report \alpha ~ ^ $5 #1; 2020.`,
      String.raw`Literal \textbackslash{} \% \{x\} \LaTeX; 2020.`,
      `Chinese 中文 {draft} 50% & more_x; 2020.`
    ]) {
      const { item } = await run(addManual(text))
      const bib = await renderBibtex([item.manual])
      const findings = await run(manuscript("symbols.bib", bib))
      expect(findings).toMatchObject([{ status: "OK", id: item.id, text: item.manual, matchedBy: "manual-text" }])
    }
  })

  test("only normalized exact manual text matches, not a changed year or a forged hash key", async () => {
    const { item: item } = await run(addManual("Zhang S. Résumé {draft} 50% & more_x; 2020."))
    const findings = await run(manuscript("changed.md", `References\n1. ${item.manual.replace("2020", "2021")}\n`))
    expect(findings[0]!.status).toBe("UNIDENTIFIED")
    const bib = await renderBibtex([item.manual])
    const roundTrip = await run(manuscript("manual.bib", bib))
    expect(roundTrip).toMatchObject([{ status: "OK", id: item.id, matchedBy: "manual-text", text: item.manual }])
    const forged = await run(manuscript("forged.bib", bib.replace("2020", "2021")))
    expect(forged[0]!.status).toBe("UNIDENTIFIED")
  })

  test("metadata reflects overrides, start line and full text, with one primary key for DOI and PMID", async () => {
    const item = paper("structured")
    await run(writeItem({ ...item, canonical: { ...item.canonical, PMID: "123456" }, overrides: { title: "The corrected title of this paper" } }))
    const findings = await run(manuscript("structured.md", `References\n1. Doe J. The corrected title of this paper.\n   Journal. 2020;3:4-9. doi:${item.canonical.DOI} PMID: 123456\n`))
    expect(findings).toHaveLength(2)
    for (const finding of findings) expect(finding).toMatchObject({ status: "OK", line: 2, entryNumber: 1, itemId: item.id, referenceTitle: "The corrected title of this paper" })
    expect(findings[0]!.text).toContain("\n   Journal.")
  })
})

describe("explicit PubMed selection and refresh reporting", () => {
  test("ESearch uses quoted DOI [aid], then validates DOI, preserving local state on replacement", async () => {
    const old = paper("pubmed")
    await run(writeItem({ ...old, overrides: { page: "7-9" } }))
    const urls: Array<string> = []
    const results = await run(fetchAndStore([old.id], [old.canonical.title], "pubmed"), (url) => {
      urls.push(url)
      if (url.includes("esearch.fcgi")) {
        expect(new URL(url).searchParams.get("term")).toBe('"10.1000/pubmed"[aid]')
        return { esearchresult: { count: "1", idlist: ["987654"] } }
      }
      expect(url).toContain("/pubmed/")
      return { ...old.canonical, DOI: "10.1000/PUBMED", PMID: "987654", page: "4-99" }
    })
    const result = results[0]!
    expect(result).toMatchObject({ ok: true, action: "updated", previousSource: "doi.org", item: {
      id: old.id, evidences: old.evidences, tags: old.tags, overrides: { page: "7-9" }, verification: { source: "pubmed", titleMatch: "VERIFIED" }
    } })
    expect(urls).toHaveLength(2)
    const again = await run(fetchAndStore([old.id], undefined, "pubmed"), (url) => {
      expect(url).not.toContain("esearch")
      return { ...old.canonical, PMID: "987654" }
    })
    expect(again[0]).toMatchObject({ action: "updated" })
    expect(again[0]).not.toHaveProperty("previousSource")
    const restored = await run(fetchAndStore([old.id]), (url) => {
      expect(url).toStartWith("https://doi.org/")
      return old.canonical
    })
    expect(restored[0]).toMatchObject({ previousSource: "pubmed", item: { verification: { source: "doi.org" }, canonical: { PMID: "987654" } } })
  })

  test("failed or ambiguous lookup, missing/wrong DOI and title mismatch never overwrite a stored record", async () => {
    const scenarios = ["none", "many", "wrong", "missing", "title", "rate", "malformed"] as const
    for (const scenario of scenarios) {
      const old = paper(`fail-${scenario}`)
      await run(writeItem(old))
      const path = join(dir, "items", fileName(old.id))
      const before = readFileSync(path, "utf8")
      const results = await run(fetchAndStore([old.id], [old.canonical.title], "pubmed"), (url) => {
        if (url.includes("esearch")) {
          if (scenario === "rate") return new Response("rate limited", { status: 429 })
          if (scenario === "malformed") return { error: "upstream failure" }
          return { esearchresult: { count: scenario === "none" ? "0" : scenario === "many" ? "2" : "1", idlist: scenario === "none" ? [] : scenario === "many" ? ["1", "2"] : ["1"] } }
        }
        return { ...old.canonical, DOI: scenario === "wrong" ? "10.1000/other" : scenario === "missing" ? undefined : old.canonical.DOI,
          title: scenario === "title" ? "An unrelated and entirely different work" : old.canonical.title }
      })
      expect(results[0]!.ok).toBe(false)
      expect(readFileSync(path, "utf8")).toBe(before)
    }
  })

  test("creation and direct PMID inputs, incompatible PMC inputs, and show source", async () => {
    const item = paper("created")
    const results = await run(fetchAndStore(["pmid:99"], undefined, "pubmed"), () => ({ ...item.canonical, PMID: "99" }))
    expect(results[0]).toMatchObject({ ok: true, action: "created" })
    expect(showLines(Option.getOrThrow(await run(readItem(item.id))))).toContain("  registry: pubmed")
    expect((await run(fetchAndStore(["pmc:99"], undefined, "pubmed")))[0]).toMatchObject({ ok: false, error: { _tag: "InvalidIdentifierError" } })
    const stored = await run(upsertItem(item.id, { canonical: item.canonical, verification: item.verification }))
    expect(stored).toMatchObject({ action: "updated", previousSource: "pubmed" })
  })
})

describe("find PMID, note management and export omission", () => {
  test("OpenAlex ids selected and PMID URI normalized into JSON and human output", async () => {
    const candidates = await run(findCandidates("A title"), (url) => {
      expect(new URL(url).searchParams.get("select")!.split(",")).toContain("ids")
      return { results: [{ id: "W1", title: "A title", ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/12345/" } }] }
    })
    expect(candidates[0]!.pmid).toBe("12345")
    expect(findLine(candidates[0]!)).toEndWith("\tpmid:12345")
  })

  test("manual adds report created/updated and align with registry results in mixed CLI output", async () => {
    const text = "Action reporting manual reference; 2026."
    const first = cli("add", "--manual", text, "--json")
    expect(first).toMatchObject({ code: 0, err: "" })
    expect(JSON.parse(first.out)[0]).toMatchObject({ action: "created", item: { manual: text } })
    const second = cli("add", "--manual", text, "--json")
    expect(JSON.parse(second.out)[0]).toMatchObject({ action: "updated" })
    const item = paper("mixed-add")
    const preload = join(dir, "registry-stub.ts")
    writeFileSync(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(item.canonical))})`)
    const mixed = (...extra: Array<string>) => Bun.spawnSync(["bun", "--preload", preload, "src/cli.ts", "add", item.id, "--manual", text, ...extra], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, IBID_DIR: dir }
    })
    const human = mixed()
    expect(human.exitCode).toBe(0)
    const lines = human.stdout.toString().trim().split("\n").map((line) => line.split("\t"))
    expect(lines.map((line) => line.length)).toEqual([8, 8])
    expect(lines.map((line) => line[0])).toEqual(["created", "updated"])
    expect(lines.map((line) => line.at(-1))).toEqual(["source doi.org", "source manual"])
    const json = mixed("--json")
    expect(json.exitCode).toBe(0)
    expect(json.stderr.toString()).toBe("")
    expect(JSON.parse(json.stdout.toString()).map((r: { action: string }) => r.action)).toEqual(["updated", "updated"])
  })

  test("note removal indices include opaque evidences; invalid operations leave the record alone", async () => {
    const item = paper("notes")
    await run(writeItem({ ...item, evidences: [{ foreign: true }, "opaque", { text: "last" }] }))
    expect(cli("show", item.id).out).toContain('evidence [2]: "opaque"')
    expect(cli("note", item.id, "--remove", "2", "--json")).toMatchObject({ code: 0, err: "" })
    expect(Option.getOrThrow(await run(readItem(item.id))).evidences).toEqual([{ foreign: true }, { text: "last" }])
    const path = join(dir, "items", fileName(item.id))
    for (const args of [["--remove", "0"], ["--remove", "3"], ["--clear", "--remove", "1"], ["text", "--clear"], ["--source", "x", "--clear"], []]) {
      const before = readFileSync(path, "utf8")
      const result = cli("note", item.id, ...args, "--json")
      expect(result).toMatchObject({ code: 1, err: "" })
      expect(JSON.parse(result.out).error._tag).toBe("UsageError")
      expect(readFileSync(path, "utf8")).toBe(before)
    }
    expect(cli("note", item.id, "--source", "reading", "--json", "--", "- bullet").code).toBe(0)
    expect(Option.getOrThrow(await run(readItem(item.id))).evidences.at(-1)).toMatchObject({ text: "- bullet", source: "reading" })
    expect(cli("note", item.id, "--clear", "--json").code).toBe(0)
    expect(Option.getOrThrow(await run(readItem(item.id))).evidences).toEqual([])
  })

  test("omit filters only render copies; manual text unchanged; unsupported formats and fields rejected", async () => {
    const item = paper("omit")
    const original = { ...item, canonical: { ...item.canonical, PMID: "13579", PMCID: "PMC13579", URL: "https://example.org/paper" } }
    await run(writeItem(original))
    const { item: manual } = await run(addManual("Manual reference PMID: 24680"))
    // A small style makes every omitted field observable in all four output formats.
    const style = { name: "omit-test", xml: `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0"><info><title>Identifiers</title><id>omit-test</id></info><bibliography><layout delimiter=" "><text variable="title"/><text variable="DOI" prefix=" DOI="/><text variable="PMID" prefix=" PMID="/><text variable="PMCID" prefix=" PMCID="/><text variable="URL" prefix=" URL="/></layout></bibliography></style>` }
    const snapshot = JSON.stringify(original)
    for (const format of ["md", "text", "html", "rtf"] as const) {
      const all = await render([{ item: original }], format, style)
      expect(all).toContain("13579")
      const omitted = await render([{ item: original }, { item: manual }], format, style, false, ["doi", "pmid", "pmcid", "url"])
      expect(omitted).not.toContain("13579")
      expect(omitted).not.toContain("10.1000/omit")
      expect(omitted).not.toContain("example.org")
      expect(omitted).toContain("24680")
    }
    expect(JSON.stringify(original)).toBe(snapshot)
    expect(Option.getOrThrow(await run(readItem(item.id)))).toEqual(original)
    for (const format of ["brief", "bibtex", "csl-json", "dossier"]) {
      const result = cli("export", "--format", format, "--omit", "pmid")
      expect(result.code).toBe(1)
      expect(result.err).toContain("--omit supports only")
    }
    expect(cli("export", "--omit", "author").code).toBe(1)
    expect(cli("export", "--omit", "pmid,pmcid", "--omit", "doi,url").code).toBe(0)
  })
})
