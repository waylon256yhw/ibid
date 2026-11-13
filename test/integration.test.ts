import { BunServices } from "@effect/platform-bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import crossref from "./fixtures/crossref-numpy.json" with { type: "json" }
import { checkNumbering } from "../src/numbering.ts"
import { checkTitle } from "../src/resolve.ts"
import { contextAt, extractIds, unidentifiedItems, verifyFile } from "../src/verify.ts"

// Where the separately built pieces meet: Word input and the numbering check inside `verify`.
describe("verify on Word files and citation numbering", () => {
  const dir = mkdtempSync(join(tmpdir(), "ibid-integration-"))
  const before = process.env.IBID_DIR
  beforeAll(() => {
    process.env.IBID_DIR = join(dir, "store")
  })
  afterAll(() => {
    if (before === undefined) delete process.env.IBID_DIR
    else process.env.IBID_DIR = before
    rmSync(dir, { recursive: true, force: true })
  })
  // Every lookup answers with the NumPy record (Harris 2020, Nature 585:357-362).
  const registry = Layer.mergeAll(
    BunServices.layer,
    Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(crossref), { status: 200 })))
    ))
  )
  const verify = (path: string) => Effect.runPromiseExit(Effect.provide(verifyFile(path), registry))
  const findings = async (path: string) => {
    const exit = await verify(path)
    if (!Exit.isSuccess(exit)) throw new Error(String(exit.cause))
    return exit.value
  }

  test("a .docx is read directly: citation findings by paragraph, then numbering findings", async () => {
    const path = join(dir, "features.docx")
    copyFileSync(`${import.meta.dir}/fixtures/features.docx`, path)
    const found = await findings(path)
    // Paragraph 4 is entry 1 (its DOI sits in a hyperlink), paragraph 7 a footnote citing another DOI.
    expect(found.map((f) => [f.status, f.location])).toEqual([["CHECK", "line 4"], ["UNIDENTIFIED", "line 5"], ["CHECK", "line 7"], ["CHECK", "line 5"]])
    expect(found[0]!.details).toContain("volume 585")
    expect(found[3]!.details).toBe("numbering: entry 2 is never cited")
  })

  test("clean numbering is one OK line; text without markers adds nothing", async () => {
    const entry = "Harris CR, et al. Array programming with NumPy. Nature. 2020;585(7825):357-62. doi:10.1038/s41586-020-2649-2"
    const cited = join(dir, "cited.md")
    writeFileSync(cited, `Arrays [1] and more arrays [2].\n\nReferences\n1. ${entry}\n2. ${entry.replace("doi:", "https://doi.org/")}\n`)
    const found = await findings(cited)
    expect(found.at(-1)).toEqual({ status: "CHECK", location: "line 5", line: 5, details: "numbering: entries 1, 2 are the same work (same identifier)" })

    const clean = join(dir, "clean.md")
    writeFileSync(clean, `Arrays [1] and other things [2].\n\nReferences\n1. ${entry}\n2. Somebody. Another paper. J Things. 2019;1:1-2.\n`)
    expect((await findings(clean)).at(-1)).toEqual({ status: "OK", location: "numbering", details: "2 entries, 2 citations: numbering is clean" })

    const plain = join(dir, "plain.md")
    writeFileSync(plain, `1. ${entry}\n`)
    expect((await findings(plain)).map((f) => f.location)).toEqual(["line 1"])
  })

  test("a file named .docx that is not one fails with one line", async () => {
    const path = join(dir, "fake.docx")
    writeFileSync(path, "plain text, not a Word file")
    const exit = await verify(path)
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("not a readable .docx file: not a ZIP archive")
  })
})

// `verify` and the numbering check must agree on what a list item is, or an entry is counted by one
// and neither isolated nor reported by the other.
describe("every numbering form is a list item to both verify and the numbering check", () => {
  const entry = (mark: string, doi?: string) => `${mark}Somebody A. A paper title. J Things. 2019;1:1-2.${doi ? ` doi:${doi}` : ""}`
  const forms: Array<[string, (n: number) => string]> = [
    ["1. ", (n) => `${n}. `],
    ["1) ", (n) => `${n}) `],
    ["tabs, as textutil writes Word lists", (n) => `\t${n}\t`],
    ["1、", (n) => `${n}、`],
    ["［1］", (n) => `［${n}］`],
    ["1． ", (n) => `${n}． `],
    ["[1] ", (n) => `[${n}] `]
  ]
  for (const [name, mark] of forms) {
    test(name, () => {
      const text = [entry(mark(1), "10.1000/a"), entry(mark(2)), entry(mark(3), "10.1000/c")].join("\n")
      // Each entry is its own context, and the one without an identifier is reported.
      expect(contextAt(text, 3)).toBe(entry(mark(3), "10.1000/c"))
      expect(unidentifiedItems(text, extractIds(text)).map((u) => u.line)).toEqual([2])
      expect(checkNumbering(`See [1], [2] and [3].\n\n${text}`)).toMatchObject({ status: "checked", entries: 3, findings: [] })
    })
  }
})

describe("title with a label before it", () => {
  const run = (expected: string, actual: string) => Effect.runSyncExit(checkTitle(expected, actual))
  test("the part after the separator may be the registry's whole title", () => {
    const title = "Mitochondrial function as a therapeutic target in heart failure"
    const exit = run(`Expert consensus document: ${title}`, title)
    expect(Exit.isSuccess(exit) && exit.value.titleMatch).toBe("FUZZY_MATCH")
    expect(Exit.isFailure(run("Note: Biology", "Biology"))).toBe(true)
  })
})

describe("skills/ibid progressive-disclosure skill & distribution", () => {
  const rootDir = join(import.meta.dir, "..")
  const skillDir = join(rootDir, "skills", "ibid")

  test("SKILL.md frontmatter and Tier 2 references are present and ensure-ibid.sh is removed", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8")
    expect(skill).toMatch(/^---\nname: ibid\ndescription: .+\n---\n/)
    for (const rel of ["references/verify-remediation.md", "references/styles-and-overrides.md"]) {
      expect(skill).toContain(rel)
      expect(existsSync(join(skillDir, rel))).toBe(true)
    }
    expect(skill).not.toContain("ensure-ibid.sh")
    expect(existsSync(join(skillDir, "scripts"))).toBe(false)
  })

  test("release ZIP packager and postinstall extractor round-trip a binary payload", async () => {
    const { createSingleFileZip } = await import("../scripts/package-release.ts")
    const { extractZipEntry, resolveTarget } = await import("../scripts/postinstall.mjs")
    const payload = new TextEncoder().encode("#!/usr/bin/env bash\necho ibid-test-payload\n")
    const zip = createSingleFileZip("ibid-darwin-aarch64/ibid", payload)
    const extracted = extractZipEntry(zip, (name: string) => name.endsWith("/ibid"))
    expect(new TextDecoder().decode(extracted)).toBe("#!/usr/bin/env bash\necho ibid-test-payload\n")
    expect(resolveTarget("darwin", "arm64")).toBe("ibid-darwin-aarch64")
    expect(resolveTarget("win32", "x64")).toBe("ibid-windows-x64")
  })

  test("bin/ibid launcher executes and reports the package version", () => {
    const proc = Bun.spawnSync([join(rootDir, "bin", "ibid"), "--version"], { cwd: rootDir })
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString().trim()).toBe("ibid v0.3.0")
  })
})
