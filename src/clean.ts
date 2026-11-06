// Text cleanup for registry strings at ingestion.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }

/** Named (the common few) and numeric HTML entities; unknown names are left as they are. */
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ENTITIES[e.toLowerCase()] ?? m)

// The inline markup citeproc understands, and what registries send for it (HTML, JATS with or without prefix).
const KEEP: Record<string, string> = {
  i: "i", em: "i", italic: "i",
  b: "b", strong: "b", bold: "b",
  sub: "sub", sup: "sup", subscript: "sub", superscript: "sup"
}
// Dropped tags that separate words.
const BLOCK = new Set(["p", "br", "title", "sec", "div"])

/**
 * Keeps `<i>`, `<b>`, `<sub>`, `<sup>` (mapping `<em>`, `<strong>`, `<jats:italic>` and the like to them),
 * drops every other tag but keeps its text, then decodes entities and collapses whitespace.
 * A `<` that does not start a tag name (`p < 0.05`) is left alone.
 */
export const cleanText = (s: string) =>
  decodeEntities(
    s.replace(/<(\/?)(?:[a-z]+:)?([a-z][\w.-]*)(?:\s[^<>]*)?\/?>/gi, (_, close: string, name: string) => {
      const tag = KEEP[name.toLowerCase()]
      return tag ? `<${close}${tag}>` : BLOCK.has(name.toLowerCase()) ? " " : ""
    })
  ).replace(/\s+/g, " ").trim()
