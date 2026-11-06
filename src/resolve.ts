import { DateTime, Effect, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import pkg from "../package.json" with { type: "json" }
import {
  Csl,
  IdentifierNotFoundError,
  InvalidIdentifierError,
  TitleMismatchError,
  UpstreamError,
  UpstreamRateLimitError,
  type Verification
} from "./schema.ts"

export const VERSION = pkg.version
const USER_AGENT = `ibid/${VERSION} (+https://github.com/waylon256yhw/ibid)`

// ---------- identifiers ----------

export type Ref = { readonly scheme: "doi"; readonly doi: string } | { readonly scheme: "pmid"; readonly pmid: string }

const DOI = /^10\.\d{4,9}\/\S+$/
const ARXIV = /^(\d{4}\.\d{4,5}|[a-z-]+(\.[a-z]{2})?\/\d{7})$/i

/** Accepts doi:, pmid:, arxiv:, a bare 10.x DOI or a doi.org URL. DOIs come back lower-cased. */
export const parseId = (raw: string): Effect.Effect<Ref, InvalidIdentifierError> => {
  const input = raw.trim()
  const invalid = (why: string) =>
    Effect.fail(new InvalidIdentifierError({ input: raw, message: `invalid identifier "${raw}": ${why}` }))
  const doi = (d: string) => DOI.test(d) ? Effect.succeed<Ref>({ scheme: "doi", doi: d.toLowerCase() }) : invalid("not a DOI (expected 10.<prefix>/<suffix>)")

  const [, scheme, rest = ""] = /^([a-z]+):(.*)$/i.exec(input) ?? []
  switch (scheme?.toLowerCase()) {
    case "doi":
      return doi(rest.trim())
    case "pmid":
      return /^\d+$/.test(rest.trim()) ? Effect.succeed({ scheme: "pmid", pmid: rest.trim() }) : invalid("PMID must be digits")
    case "arxiv": {
      const id = rest.trim().replace(/v\d+$/i, "")
      return ARXIV.test(id) ? doi(`10.48550/arXiv.${id}`) : invalid("not an arXiv id")
    }
    case "http":
    case "https": {
      const m = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(input)
      return m ? doi(decodeURIComponent(m[1]!)) : invalid("only https://doi.org/ URLs are accepted")
    }
  }
  return input.startsWith("10.") ? doi(input) : invalid("expected doi:, pmid:, arxiv:, a bare 10.x DOI or a https://doi.org/ URL")
}

// ---------- CSL normalization ----------

const StrOrNum = Schema.Union([Schema.String, Schema.Number])
const StrOrList = Schema.Union([Schema.String, Schema.Array(Schema.String)])

// What the registries actually send. Unknown keys are dropped by decoding.
export const RawCsl = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  title: StrOrList,
  author: Schema.optionalKey(Schema.Array(Schema.Struct({
    family: Schema.optionalKey(Schema.String),
    given: Schema.optionalKey(Schema.String),
    literal: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String)
  }))),
  issued: Schema.optionalKey(Schema.Struct({
    "date-parts": Schema.optionalKey(Schema.Array(Schema.Array(Schema.Union([Schema.Number, Schema.String, Schema.Null]))))
  })),
  "container-title": Schema.optionalKey(StrOrList),
  "container-title-short": Schema.optionalKey(StrOrList),
  volume: Schema.optionalKey(StrOrNum),
  issue: Schema.optionalKey(StrOrNum),
  page: Schema.optionalKey(StrOrNum),
  publisher: Schema.optionalKey(Schema.String),
  ISSN: Schema.optionalKey(StrOrList),
  DOI: Schema.optionalKey(Schema.String),
  PMID: Schema.optionalKey(StrOrNum),
  PMCID: Schema.optionalKey(StrOrNum),
  URL: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String)
})

// Registry (mostly Crossref) work types -> CSL types.
const TYPE_MAP: Record<string, string> = {
  "journal-article": "article-journal",
  "proceedings-article": "paper-conference",
  "book-chapter": "chapter",
  "book-section": "chapter",
  "book-part": "chapter",
  "book-track": "chapter",
  "posted-content": "article",
  "monograph": "book",
  "edited-book": "book",
  "reference-book": "book",
  "book-set": "book",
  "book-series": "book",
  "proceedings": "book",
  "dissertation": "thesis",
  "reference-entry": "entry",
  "report-component": "report",
  "report-series": "report",
  "peer-review": "review",
  "journal": "periodical",
  "journal-issue": "periodical",
  "journal-volume": "periodical"
}
const CSL_TYPES = new Set(
  ("article article-journal article-magazine article-newspaper bill book broadcast chapter classic collection dataset " +
    "document entry entry-dictionary entry-encyclopedia event figure graphic hearing interview legal_case legislation " +
    "manuscript map motion_picture musical_score pamphlet paper-conference patent performance periodical " +
    "personal_communication post post-weblog regulation report review review-book software song speech standard " +
    "thesis treaty webpage").split(" ")
)
/** Unknown types fall back to "document", the generic CSL 1.0.2 type. */
export const cslType = (t: string | undefined) => {
  const v = (t ?? "").toLowerCase()
  return TYPE_MAP[v] ?? (CSL_TYPES.has(v) ? v : "document")
}

const one = (v: string | ReadonlyArray<string> | undefined) => (typeof v === "string" ? v : v?.[0])?.replace(/\s+/g, " ").trim() || undefined
const str = (v: string | number | undefined) => v === undefined ? undefined : String(v).trim() || undefined

const decodeCsl = Schema.decodeUnknownSync(Csl)

export const normalizeCsl = (raw: typeof RawCsl.Type): Csl => {
  const author = raw.author?.map((a) =>
    a.family || a.given
      ? { ...(a.family && { family: a.family }), ...(a.given && { given: a.given }) }
      : { literal: a.literal ?? a.name ?? "" }
  ).filter((a) => !("literal" in a) || a.literal)
  const dateParts = raw.issued?.["date-parts"]
    ?.map((parts) => parts.map(Number).filter((n) => Number.isFinite(n) && n > 0))
    .filter((parts) => parts.length > 0)
  const issn = raw.ISSN === undefined ? undefined : typeof raw.ISSN === "string" ? [raw.ISSN] : raw.ISSN
  const fields = {
    type: cslType(raw.type),
    title: one(raw.title) ?? "",
    author: author?.length ? author : undefined,
    issued: dateParts?.length ? { "date-parts": dateParts } : undefined,
    "container-title": one(raw["container-title"]),
    "container-title-short": one(raw["container-title-short"]),
    volume: str(raw.volume),
    issue: str(raw.issue),
    page: str(raw.page),
    publisher: raw.publisher,
    ISSN: issn?.length ? issn : undefined,
    DOI: raw.DOI?.trim().toLowerCase(),
    PMID: str(raw.PMID),
    PMCID: str(raw.PMCID),
    URL: raw.URL,
    language: raw.language?.trim() || undefined
  }
  return decodeCsl(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)))
}

// ---------- title check ----------

export const TITLE_FUZZY_THRESHOLD = 0.9

export const normalizeTitle = (s: string) =>
  s.replace(/<[^>]*>/g, " ")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

/** Character-bigram Dice coefficient. */
export const similarity = (a: string, b: string) => {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const counts = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) counts.set(a.slice(i, i + 2), (counts.get(a.slice(i, i + 2)) ?? 0) + 1)
  let hits = 0
  for (let i = 0; i < b.length - 1; i++) {
    const n = counts.get(b.slice(i, i + 2)) ?? 0
    if (n > 0) {
      counts.set(b.slice(i, i + 2), n - 1)
      hits++
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1)
}

export type TitleResult = Pick<Verification, "titleMatch" | "expectedTitle" | "similarity">

export const checkTitle = (expected: string | undefined, actual: string): Effect.Effect<TitleResult, TitleMismatchError> => {
  if (expected === undefined) return Effect.succeed({ titleMatch: "UNCHECKED" })
  const a = normalizeTitle(expected)
  const b = normalizeTitle(actual)
  if (a === b) return Effect.succeed({ titleMatch: "VERIFIED", expectedTitle: expected, similarity: 1 })
  const score = Math.round(similarity(a, b) * 1000) / 1000
  return score >= TITLE_FUZZY_THRESHOLD
    ? Effect.succeed({ titleMatch: "FUZZY_MATCH", expectedTitle: expected, similarity: score })
    : Effect.fail(new TitleMismatchError({
      expected,
      actual,
      similarity: score,
      message: `title mismatch (similarity ${score}): expected "${expected}", registry has "${actual}"`
    }))
}

// ---------- resolver ----------

export type Fetched = { canonical: Csl; verification: Omit<Verification, "titleMatch" | "expectedTitle" | "similarity"> }

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodeRaw = Schema.decodeUnknownEffect(RawCsl)

export const fetchCsl = Effect.fn("fetchCsl")(function*(ref: Ref) {
  const [source, url, accept, label] = ref.scheme === "doi"
    ? ["doi.org", `https://doi.org/${ref.doi.split("/").map(encodeURIComponent).join("/")}`, "application/vnd.citationstyles.csl+json", `doi:${ref.doi}`] as const
    : ["pubmed", `https://pmc.ncbi.nlm.nih.gov/api/ctxp/v1/pubmed/?format=csl&id=${ref.pmid}`, "*/*", `pmid:${ref.pmid}`] as const
  const upstream = (message: string) => new UpstreamError({ url, message: `${label}: ${message}` })

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeaders({ Accept: accept, "User-Agent": USER_AGENT })),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({ schedule: Schedule.exponential(200), times: 2 })
  )
  const body = yield* client.get(url).pipe(
    Effect.flatMap((res) => res.text),
    Effect.mapError((e) => {
      const status = e.reason._tag === "StatusCodeError" ? e.reason.response.status : undefined
      if (status === 404) return new IdentifierNotFoundError({ id: label, message: `${label}: not found at ${source}` })
      if (status === 429) return new UpstreamRateLimitError({ url, message: `${label}: rate limited by ${source} (HTTP 429)` })
      return upstream(status ? `HTTP ${status} from ${source}` : e.message)
    })
  )
  const json = yield* decodeJson(body).pipe(Effect.mapError(() => upstream(`${source} returned non-JSON`)))
  // The PubMed exporter 406s on any Accept but */*, and answers an unknown PMID with HTTP 200 and an empty array.
  if (Array.isArray(json) && json.length === 0) {
    return yield* new IdentifierNotFoundError({ id: label, message: `${label}: not found at ${source}` })
  }
  const raw = yield* decodeRaw(json).pipe(Effect.mapError((e) => upstream(`unexpected CSL from ${source}: ${e.message}`)))
  return {
    canonical: normalizeCsl(raw),
    verification: {
      source,
      url,
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
      sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex")
    }
  } satisfies Fetched
})
