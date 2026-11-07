import { inflateRawSync } from "node:zlib"

// ---------- ZIP ----------

/**
 * The files of a ZIP archive by name, each decompressed on demand. Stored and deflated entries only,
 * and no ZIP64, which only archives over 4 GB or with 65,535 entries need.
 */
const unzip = (bytes: Uint8Array) => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end-of-central-directory record is the last 22 bytes plus a comment of at most 64 KB.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive")
  const files = new Map<string, () => string>()
  let p = v.getUint32(eocd + 16, true)
  for (let n = v.getUint16(eocd + 10, true); n > 0; n--) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("damaged ZIP archive")
    const [flags, method, size] = [v.getUint16(p + 8, true), v.getUint16(p + 10, true), v.getUint32(p + 20, true)]
    const nameLength = v.getUint16(p + 28, true)
    const local = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength))
    p += 46 + nameLength + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
    files.set(name, () => {
      if (flags & 1) throw new Error(`${name} is encrypted`)
      // Sizes come from the central directory: the local header may defer them to a data descriptor.
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
      const raw = bytes.subarray(start, start + size)
      if (method !== 0 && method !== 8) throw new Error(`${name} uses unsupported compression method ${method}`)
      return new TextDecoder().decode(method === 8 ? inflateRawSync(raw) : raw)
    })
  }
  return files
}

// ---------- WordprocessingML ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }

export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(Number.parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10)) : ENTITIES[e] ?? m)

const attr = (attrs: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)
  return m ? decodeEntities(m[1]!) : undefined
}

/** Relationship id to target, from a `.rels` part. */
export const parseRels = (xml: string) =>
  new Map([...xml.matchAll(/<Relationship\b([^>]*)>/g)].flatMap((m) => {
    const [id, target] = [attr(m[1]!, "Id"), attr(m[1]!, "Target")]
    return id && target ? [[id, target] as const] : []
  }))

/** Per list (`numId`) and level: the number format (`decimal`, `bullet`, ...) and start value. */
export type Numbering = Map<string, Map<string, { format: string; start: number }>>

/** `word/numbering.xml`: each list instance resolved through its abstract definition and start overrides. */
export const parseNumbering = (xml: string): Numbering => {
  const val = (s: string, tag: string) => new RegExp(`<w:${tag}\\b[^>]*\\sw:val="([^"]*)"`).exec(s)?.[1]
  const abstract = new Map([...xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)].map((a) => [
    a[1]!,
    new Map([...a[2]!.matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)].map((l) => [
      l[1]!,
      { format: val(l[2]!, "numFmt") ?? "decimal", start: Number(val(l[2]!, "start") ?? 1) }
    ]))
  ]))
  return new Map([...xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)].map((n) => {
    const levels = new Map(abstract.get(val(n[2]!, "abstractNumId") ?? "") ?? [])
    for (const o of n[2]!.matchAll(/<w:lvlOverride\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/g)) {
      const start = val(o[2]!, "startOverride")
      if (start !== undefined) levels.set(o[1]!, { format: levels.get(o[1]!)?.format ?? "decimal", start: Number(start) })
    }
    return [n[1]!, levels]
  }))
}

/** A DOI in a link target, percent-decoded. */
const doiIn = (url: string) => {
  let u = url
  try {
    u = decodeURIComponent(url)
  } catch {}
  return /\b10\.\d{4,9}\/[^\s?#]+/.exec(u)?.[0]
}

/**
 * Elements whose content is not part of the visible text: deleted or moved-away revisions, the previous
 * properties kept by tracked formatting changes, and the VML duplicate of a text box.
 */
const SKIP = new Set(["w:del", "w:moveFrom", "w:pPrChange", "w:rPrChange", "w:numberingChange", "mc:Fallback"])

type Paragraph = { text: string; numId?: string; ilvl: string }
type Field = { result: boolean; instr: string; link?: { p: Paragraph; at: number; url: string } }

/**
 * Plain text of a WordprocessingML part (`document.xml`, `footnotes.xml`, `endnotes.xml`): one line per
 * paragraph in document order (a paragraph nested in a text box comes before its host), runs joined,
 * `w:tab` as a tab and `w:br` as U+2028 (a page break as a form feed) as `textutil` writes them. Tracked insertions are kept and deletions
 * dropped. Of a field (Zotero, EndNote, HYPERLINK), only the displayed result is kept. A link whose target
 * (`rels`, or a HYPERLINK field) holds a DOI absent from its text becomes `[text](url)`. A paragraph in an
 * automatically numbered list gets `N. ` (or `- ` for other formats) from a counter per list and level.
 */
export const xmlToText = (xml: string, rels = new Map<string, string>(), numbering: Numbering = new Map()) => {
  const lines: Array<string> = []
  const paragraphs: Array<Paragraph> = []
  const fields: Array<Field> = []
  const links: Array<{ p: Paragraph; at: number; url?: string }> = []
  const counters = new Map<string, Array<number>>()
  let depth = 0
  let skipAt = -1
  let inText = false
  let inInstr = false
  let inRun = 0
  let inPPr = false
  const visible = () => fields.every((f) => f.result)
  const current = () => paragraphs[paragraphs.length - 1]
  const append = (s: string) => {
    const p = current()
    if (p && visible()) p.text += s
  }
  const linkEnd = (p: Paragraph, at: number, url: string | undefined) => {
    const doi = url && doiIn(url)
    // A link that spans paragraphs is left as it is.
    if (!doi || current() !== p) return
    const text = p.text.slice(at)
    if (!text.toLowerCase().includes(doi.toLowerCase())) p.text = `${p.text.slice(0, at)}[${text}](https://doi.org/${doi})`
  }
  // ponytail: only numbering set on the paragraph itself; numbering inherited from a paragraph style
  // (styles.xml) and counters shared by lists of one abstract definition are not followed. Add both if a
  // real document needs them.
  const prefix = (p: Paragraph) => {
    if (p.numId === undefined || p.numId === "0") return ""
    const level = Number(p.ilvl)
    const def = numbering.get(p.numId)?.get(p.ilvl) ?? { format: "decimal", start: 1 }
    const counts = counters.get(p.numId) ?? []
    counts[level] = (counts[level] ?? def.start - 1) + 1
    counts.length = level + 1 // a higher-level item restarts the levels below it
    counters.set(p.numId, counts)
    if (def.format === "none") return ""
    return def.format === "bullet" ? "- " : `${counts[level]}. `
  }

  for (const m of xml.matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g)) {
    const [, close, name, attrs = "", selfClosing, text] = m
    if (text !== undefined) {
      if (skipAt >= 0) continue
      if (inText) append(decodeEntities(text))
      else if (inInstr && fields.length) fields[fields.length - 1]!.instr += decodeEntities(text)
      continue
    }
    if (close) {
      depth--
      if (skipAt >= 0) {
        if (depth === skipAt) skipAt = -1
        continue
      }
      if (name === "w:t") inText = false
      else if (name === "w:instrText") inInstr = false
      else if (name === "w:r") inRun--
      else if (name === "w:pPr") inPPr = false
      else if (name === "w:hyperlink") {
        const l = links.pop()
        if (l) linkEnd(l.p, l.at, l.url)
      } else if (name === "w:p") {
        const p = paragraphs.pop()!
        lines.push(prefix(p) + p.text)
      }
      continue
    }
    if (skipAt >= 0) {
      if (!selfClosing) depth++
      continue
    }
    // Separator and continuation notes in footnotes.xml and endnotes.xml carry no text of their own.
    const separator = (name === "w:footnote" || name === "w:endnote") && /\sw:type="(?!normal")/.test(attrs)
    if (!selfClosing && (SKIP.has(name!) || separator)) {
      skipAt = depth++
      continue
    }
    if (!selfClosing) depth++
    switch (name) {
      case "w:p":
        if (selfClosing) lines.push("")
        else paragraphs.push({ text: "", ilvl: "0" })
        break
      case "w:pPr":
        inPPr = !selfClosing
        break
      case "w:numId":
      case "w:ilvl": {
        const p = current()
        if (p && inPPr) p[name === "w:numId" ? "numId" : "ilvl"] = attr(attrs, "w:val") ?? "0"
        break
      }
      case "w:r":
        if (!selfClosing) inRun++
        break
      case "w:t":
        inText = !selfClosing
        break
      case "w:instrText":
        inInstr = !selfClosing
        break
      case "w:tab":
        if (inRun) append("\t")
        break
      case "w:br":
      case "w:cr":
        if (inRun) append(attr(attrs, "w:type") === "page" ? "\f" : " ")
        break
      case "w:noBreakHyphen":
        append("-")
        break
      case "w:hyperlink": {
        const p = current()
        if (!selfClosing && p) links.push({ p, at: p.text.length, url: rels.get(attr(attrs, "r:id") ?? "") })
        break
      }
      case "w:fldChar": {
        const type = attr(attrs, "w:fldCharType")
        if (type === "begin") fields.push({ result: false, instr: "" })
        else if (type === "separate" && fields.length) {
          const f = fields[fields.length - 1]!
          f.result = true
          const url = /^\s*HYPERLINK\s+"([^"]+)"/.exec(f.instr)?.[1]
          const p = current()
          if (url && p) f.link = { p, at: p.text.length, url }
        } else if (type === "end") {
          const f = fields.pop()
          if (f?.link) linkEnd(f.link.p, f.link.at, f.link.url)
        }
        break
      }
    }
  }
  return lines.join("\n")
}

/**
 * The text of a `.docx` file: the body (`word/document.xml`), then the footnotes and endnotes when there are
 * any, each after an empty line, one line per paragraph as `xmlToText` writes it, ending with a newline.
 * Throws an `Error` with a one-line message when the bytes are not a readable `.docx`.
 */
export const docxText = (bytes: Uint8Array): string => {
  // An encrypted .docx, like a .doc, is an OLE compound file rather than a ZIP archive.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new Error("not a readable .docx file: it is encrypted or in the old .doc format; save it from Word as .docx without a password")
  }
  try {
    const files = unzip(bytes)
    const read = (name: string) => files.get(name)?.()
    const body = read("word/document.xml")
    if (body === undefined) throw new Error("no word/document.xml, so not a Word document")
    const rels = (part: string) => parseRels(read(`word/_rels/${part}.rels`) ?? "")
    const numbering = parseNumbering(read("word/numbering.xml") ?? "")
    const parts = [xmlToText(body, rels("document.xml"), numbering)]
    for (const part of ["footnotes.xml", "endnotes.xml"]) {
      const xml = read(`word/${part}`)
      const text = xml === undefined ? "" : xmlToText(xml, rels(part), numbering)
      if (text !== "") parts.push("", text)
    }
    return `${parts.join("\n")}\n`
  } catch (e) {
    throw new Error(`not a readable .docx file: ${e instanceof Error ? e.message : String(e)}`)
  }
}
