import { describe, expect, test } from "bun:test"
import { checkNumbering } from "../src/numbering.ts"

const REFS = [
  "Harris CR, Millman KJ, van der Walt SJ, et al. Array programming with NumPy. Nature. 2020;585:357-362. doi:10.1038/s41586-020-2649-2",
  "LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015;521:436-444. doi:10.1038/nature14539",
  "Vaswani A, Shazeer N, Parmar N, et al. Attention is all you need. Adv Neural Inf Process Syst. 2017;30.",
  "Jumper J, Evans R, Pritzel A, et al. Highly accurate protein structure prediction with AlphaFold. Nature. 2021;596:583-589.",
  "He K, Zhang X, Ren S, Sun J. Deep residual learning for image recognition. Proc CVPR. 2016:770-778."
]
const list = (ns: ReadonlyArray<number>, refs: ReadonlyArray<string> = REFS) => ns.map((n, i) => `${n}. ${refs[i]}`).join("\n")
const doc = (body: string, refs = list([1, 2, 3, 4, 5])) => `Title\n\n${body}\n\nReferences\n${refs}\n`
const kinds = (text: string) => checkNumbering(text).findings.map((f) => [f.kind, f.numbers, f.line])

describe("checkNumbering", () => {
  test("a clean document", () => {
    const r = checkNumbering(doc("Arrays [1] and deep nets [2,3].\nProteins [4–5] again [1]."))
    expect(r).toEqual({ status: "checked", message: "5 entries, 6 citations: numbering is clean", entries: 5, citations: 6, findings: [] })
  })

  test("a cited number with no entry", () => {
    expect(kinds(doc("See [1-5] and [7]."))).toEqual([["missing-entry", [7], 3]])
  })

  test("entries never cited", () => {
    expect(kinds(doc("See [1, 2] and [5]."))).toEqual([["uncited", [3], 8], ["uncited", [4], 9]])
  })

  test("first citations out of ascending order", () => {
    const r = checkNumbering(doc("First [1], then [3].\nLater [2], [4], [5]."))
    expect(r.findings).toEqual([{ kind: "out-of-order", numbers: [2, 3], line: 4, message: "[2] is first cited after [3]" }])
  })

  test("gaps and repeated numbers in the list", () => {
    const refs = list([2, 3, 3, 6, 7])
    expect(kinds(doc("See [2-7].", refs))).toEqual([
      ["missing-entry", [4], 3],
      ["missing-entry", [5], 3],
      ["gap", [1], 6],
      ["repeated", [3], 8],
      ["gap", [4, 5], 9]
    ])
  })

  test("the same work listed twice: same DOI, same PMID, near-identical text", () => {
    const refs = list([1, 2, 3, 4, 5, 6], [
      REFS[0]!,
      "LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015;521:436-444. PMID: 26017442",
      REFS[2]!,
      "Harris CR, et al. Array programming with NumPy. Nature 585, 357 (2020). https://doi.org/10.1038/S41586-020-2649-2",
      "LeCun Y, Bengio Y, Hinton G. Deep learning. Nature 2015. PMID 26017442.",
      "Vaswani A, Shazeer N, Parmar N, et al. Attention is all you need. Adv. Neural Inf. Process. Syst. 2017;30"
    ])
    const r = checkNumbering(doc("See [1-6].", refs))
    expect(r.findings.map((f) => [f.kind, f.numbers, f.line])).toEqual([
      ["duplicate", [1, 4], 9],
      ["duplicate", [2, 5], 10],
      ["duplicate", [3, 6], 11]
    ])
    expect(r.findings[0]!.message).toBe("entries 1, 4 are the same work (same identifier)")
    expect(r.findings[2]!.message).toBe("entries 3, 6 are the same work (near-identical text)")
  })

  test("not duplicates: different works by the same authors, near-identical text with different DOIs", () => {
    const refs = list([1, 2, 3, 4], [
      "Smith J, Lee K. Mapping cortical layers with diffusion imaging. Neuroimage. 2019;190:1-10.",
      "Smith J, Lee K. Mapping cortical layers with functional imaging. Neuroimage. 2020;210:11-20.",
      "Smith J, Lee K. Cortical layers in mice. Neuroimage. 2021;220:1. doi:10.5555/one",
      "Smith J, Lee K. Cortical layers in mice. Neuroimage. 2021;220:1. doi:10.5555/two"
    ])
    expect(checkNumbering(doc("See [1-4].", refs)).findings).toEqual([])
  })

  test("a second numbered run that is not the reference list", () => {
    const text = [
      "Protocol",
      "1. Thaw cells [1].",
      "2. Plate them at 10^5 per well [2].",
      "3. Incubate for 24 h.",
      "",
      "Results follow [3-5].",
      "",
      "References",
      list([1, 2, 3, 4, 5])
    ].join("\n")
    const r = checkNumbering(text)
    expect([r.status, r.entries, r.citations, r.findings]).toEqual(["checked", 5, 5, []])
  })

  test("without a heading, the longest run is the list, so numbered section headings do not count", () => {
    const text = ["1. Introduction", "Arrays [1].", "2. Methods", "Nets [2-5].", "", list([1, 2, 3, 4, 5])].join("\n")
    expect(checkNumbering(text)).toMatchObject({ status: "checked", entries: 5, citations: 5, findings: [] })
  })

  test("a shorter numbered list after the references is not the list", () => {
    const text = doc("Arrays [1-5].") + "\nAppendix\n1. Step one.\n2. Step two.\n"
    expect(checkNumbering(text)).toMatchObject({ entries: 5, findings: [] })
  })

  test("full-width brackets, commas, dashes and Chinese headings", () => {
    const text = ["正文引用［1］，以及【不是引用】和［2，3］，范围［4－5］、[1–2, 5]。", "", "参考文献", list([1, 2, 3, 4, 5], REFS).replace(/^(\d)\. /gm, "[$1] ")].join("\n")
    expect(checkNumbering(text)).toMatchObject({ status: "checked", entries: 5, citations: 8, findings: [] })
  })

  test("list markers: `1)`, `1、`, a tab as textutil writes Word numbers, entries over several lines", () => {
    const text = ["Text [1] [2] [3].", "", "References", `\t1\t${REFS[0]}`, `2) ${REFS[1]}`, `3、${REFS[2]!.slice(0, 30)}`, REFS[2]!.slice(30)].join("\n")
    expect(checkNumbering(text)).toMatchObject({ entries: 3, citations: 3, findings: [] })
  })

  test("brackets that are not citations: intervals with 0, years, list markers", () => {
    const text = doc("Values in [0, 1] since [2019], see [1-5].\n[3] is a list marker here\n[4] too")
    expect(checkNumbering(text)).toMatchObject({ citations: 5, findings: [] })
  })

  test("no numbered reference list, or no numeric citations", () => {
    expect(checkNumbering("Plain prose (Harris et al., 2020).\n")).toEqual({
      status: "no-list",
      message: "no numbered reference list found",
      entries: 0,
      citations: 0,
      findings: []
    })
    // Without a References heading, a single numbered line is not treated as a reference list.
    expect(checkNumbering("See [1].\n\n1. Introduction\n")).toMatchObject({ status: "no-list", entries: 0, citations: 0, findings: [] })
    expect(checkNumbering(doc("Arrays (Harris et al., 2020)."))).toMatchObject({ status: "no-citations", entries: 5, citations: 0, findings: [] })
  })

  test("a single-entry reference list under an explicit heading is checked", () => {
    expect(kinds("See [2].\n\nReferences\n1. Only reference.\n")).toEqual([
      ["missing-entry", [2], 1],
      ["uncited", [1], 4]
    ])
    expect(checkNumbering("See [1].\n\nReferences\n1. Only reference.\n")).toMatchObject({
      status: "checked",
      entries: 1,
      citations: 1,
      findings: []
    })
  })
})
