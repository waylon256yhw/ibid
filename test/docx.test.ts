import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { docxText, parseNumbering, parseRels, xmlToText } from "../src/docx.ts"

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="r"`
const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`
const p = (...runs: Array<string>) => `<w:p>${runs.join("")}</w:p>`
const r = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const numbered = (numId: string, text: string, ilvl = "0") =>
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${r(text)}</w:p>`

describe("xmlToText", () => {
  test("one line per paragraph, empty paragraphs as empty lines", () => {
    expect(xmlToText(doc(p(r("One")) + "<w:p/>" + p() + p(r("Two"))))).toBe("One\n\n\nTwo")
  })

  test("runs joined, tabs and breaks as textutil writes them; tab stops are not tabs", () => {
    const body = `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>`
      + `<w:r><w:t>Har</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>ris</w:t></w:r><w:r><w:tab/><w:t>CR</w:t><w:br/><w:t>next</w:t><w:br w:type="page"/></w:r></w:p>`
    expect(xmlToText(doc(body))).toBe("Harris\tCR next\f")
  })

  test("XML entities", () => {
    expect(xmlToText(doc(p(r("Molecular &amp; Cellular &lt;i&gt; &quot;x&quot; &apos;y&apos; &#8211; &#x2013;"))))).toBe(
      "Molecular & Cellular <i> \"x\" 'y' – –"
    )
  })

  test("tracked changes: insertions kept, deletions and moved-away text dropped", () => {
    const body = p(
      r("Nature. "),
      `<w:del w:id="1" w:author="A"><w:r><w:delText>2016</w:delText></w:r></w:del>`,
      `<w:ins w:id="2" w:author="A">${r("2015")}</w:ins>`,
      `<w:moveFrom w:id="3" w:author="A">${r(" old place")}</w:moveFrom>`,
      `<w:moveTo w:id="4" w:author="A">${r(";521")}</w:moveTo>`
    )
    expect(xmlToText(doc(body))).toBe("Nature. 2015;521")
  })

  test("numbering in a tracked property change is the old state, not the current one", () => {
    const body = `<w:p><w:pPr><w:pPrChange w:id="1" w:author="A"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:pPrChange></w:pPr>${r("plain")}</w:p>`
    expect(xmlToText(doc(body))).toBe("plain")
  })

  describe("hyperlinks", () => {
    const rels = new Map([["rId1", "https://doi.org/10.1038/s41586-020-2649-2"], ["rId2", "https://example.org/page"]])
    test("a DOI target missing from the text becomes a Markdown link", () => {
      const body = p(r("Harris CR. Nature. 2020. "), `<w:hyperlink r:id="rId1" w:history="1">${r("Full")}${r(" text")}</w:hyperlink>`, r("."))
      expect(xmlToText(doc(body), rels)).toBe("Harris CR. Nature. 2020. [Full text](https://doi.org/10.1038/s41586-020-2649-2).")
    })
    test("left as text when the text already shows the DOI, or the target is not a DOI", () => {
      const shown = `<w:hyperlink r:id="rId1">${r("doi:10.1038/S41586-020-2649-2")}</w:hyperlink>`
      const other = `<w:hyperlink r:id="rId2">${r("site")}</w:hyperlink>`
      const anchor = `<w:hyperlink w:anchor="_Ref1">${r("[1]")}</w:hyperlink>`
      expect(xmlToText(doc(p(shown, r(" "), other, r(" "), anchor)), rels)).toBe("doi:10.1038/S41586-020-2649-2 site [1]")
    })
    test("a HYPERLINK field is treated the same way", () => {
      const body = p(
        `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://doi.org/10.1038/nature14539" </w:instrText></w:r>`,
        `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r("link")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
      )
      expect(xmlToText(doc(body))).toBe("[link](https://doi.org/10.1038/nature14539)")
    })
    test("percent-encoded DOI targets", () => {
      const body = p(`<w:hyperlink r:id="rId1">${r("10.1038/s41586-020-2649-2")}</w:hyperlink>`)
      expect(xmlToText(doc(body), new Map([["rId1", "https://doi.org/10.1038%2Fs41586-020-2649-2"]]))).toBe("10.1038/s41586-020-2649-2")
    })
  })

  describe("automatic numbering", () => {
    const numbering = parseNumbering(`<w:numbering ${W}>
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="[%1]"/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
      <w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>
    </w:numbering>`)
    test("a counter per list, a start override, bullets as `- `, levels restarting", () => {
      const body = numbered("1", "First") + numbered("2", "point") + numbered("1", "Second") + numbered("1", "sub", "1")
        + numbered("1", "sub", "1") + numbered("1", "Third") + numbered("1", "sub", "1") + numbered("3", "Fifth") + numbered("0", "not a list")
      expect(xmlToText(doc(body), new Map(), numbering).split("\n")).toEqual([
        "1. First",
        "- point",
        "2. Second",
        "1. sub",
        "2. sub",
        "3. Third",
        "1. sub",
        "5. Fifth",
        "not a list"
      ])
    })
    test("without numbering.xml, a numbered paragraph counts from 1", () => {
      expect(xmlToText(doc(numbered("7", "A") + numbered("7", "B")))).toBe("1. A\n2. B")
    })
  })

  test("fields: the displayed result is kept, the instructions dropped, nested fields included", () => {
    const zotero = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION {"citationItems":[{"id":1}]} </w:instrText></w:r>`
      + `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r("[1,2]")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
    const endnote = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ADDIN EN.CITE </w:instrText></w:r>`
      + `<w:r><w:fldChar w:fldCharType="begin"><w:fldData xml:space="preserve">PEVuZE5vdGU+</w:fldData></w:fldChar></w:r><w:r><w:instrText> ADDIN EN.CITE.DATA </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
      + `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r("[3]")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
    const simple = `<w:fldSimple w:instr=" ADDIN EN.REFLIST ">${r("4. Ref")}</w:fldSimple>`
    expect(xmlToText(doc(p(r("Shown "), zotero, r(" and "), endnote) + p(simple)))).toBe("Shown [1,2] and [3]\n4. Ref")
  })

  test("text boxes once, not with their VML fallback copy", () => {
    const box = `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${p(r("Boxed"))}</w:txbxContent></w:drawing></mc:Choice>`
      + `<mc:Fallback><w:pict><w:txbxContent>${p(r("Boxed"))}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>`
    expect(xmlToText(doc(p(r("Host"), box)))).toBe("Boxed\nHost")
  })

  test("footnotes: separators dropped, notes kept", () => {
    const xml = `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>`
      + `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`
      + `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${r(" Note one.")}</w:p></w:footnote></w:footnotes>`
    expect(xmlToText(xml)).toBe(" Note one.")
  })
})

test("parseRels", () => {
  expect(parseRels(`<Relationships><Relationship Target="https://x.org/?a=1&amp;b=2" Id="rId3" TargetMode="External"/></Relationships>`)).toEqual(
    new Map([["rId3", "https://x.org/?a=1&b=2"]])
  )
})

describe("docxText", () => {
  test("a textutil-written file (deflated) reads as textutil reads it", () => {
    // numbered.docx is `textutil -convert docx numbered.html`; textutil writes list numbers as text.
    expect(docxText(readFileSync(`${import.meta.dir}/fixtures/numbered.docx`))).toBe(
      "Arrays & tensors\nArray programming underpins scientific Python [1]. Deep learning frameworks build on it [2].\n\nSee the NumPy paper for details.\nReferences\n"
        + "\t1\tHarris CR, Millman KJ, van der Walt SJ, et al. Array programming with NumPy. Nature. 2020;585:357-362.\n"
        + "\t2\tLeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015;521:436-444. doi:10.1038/nature14539\n"
    )
  })

  test("a stored file with numbering, a hyperlink, tracked changes, a field and a footnote", () => {
    // features.docx is `zip -X -0 -r ../features.docx word` run in fixtures/features-docx.
    expect(docxText(readFileSync(`${import.meta.dir}/fixtures/features.docx`))).toBe(
      "Array programming is central [1].\n\nReferences\n"
        + "1. Harris CR, et al. Array programming with NumPy. Nature. 2020. [Full text](https://doi.org/10.1038/s41586-020-2649-2)\n"
        + "2. LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015.\n"
        + "\n See also doi:10.1038/nature14539.\n"
    )
  })

  test("one-line errors for what is not a readable .docx", () => {
    const err = (bytes: Uint8Array) => {
      try {
        docxText(bytes)
      } catch (e) {
        return (e as Error).message
      }
    }
    expect(err(new TextEncoder().encode("just some text, not a zip file at all"))).toBe("not a readable .docx file: not a ZIP archive")
    expect(err(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toMatch(/encrypted or in the old \.doc format/)
    expect(err(new Uint8Array(0))).toBe("not a readable .docx file: not a ZIP archive")
    // An empty ZIP archive: only the end-of-central-directory record.
    const empty = new Uint8Array(22)
    new DataView(empty.buffer).setUint32(0, 0x06054b50, true)
    expect(err(empty)).toBe("not a readable .docx file: no word/document.xml, so not a Word document")
    // A truncated archive.
    const bytes = readFileSync(`${import.meta.dir}/fixtures/numbered.docx`)
    expect(err(bytes.subarray(0, bytes.length - 30))).toMatch(/^not a readable \.docx file: /)
    for (const m of [err(empty), err(bytes.subarray(0, 100))]) expect(m).not.toContain("\n")
  })
})
