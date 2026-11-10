import { Cause, DateTime, Effect, Schedule, Schema } from "effect"
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http"
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
import { cleanText, decodeEntities } from "./clean.ts"

export const VERSION = pkg.version
const USER_AGENT = `ibid/${VERSION} (+https://github.com/waylon256yhw/ibid)`

// ---------- identifiers ----------

export type Ref =
  | { readonly scheme: "doi"; readonly doi: string }
  | { readonly scheme: "pmid"; readonly pmid: string }
  | { readonly scheme: "pmc"; readonly pmc: string }

const DOI = /^10\.\d{4,9}\/\S+$/
const ARXIV = /^(\d{4}\.\d{4,5}|[a-z-]+(\.[a-z]{2})?\/\d{7})$/i

/** Accepts doi:, pmid:, pmc: (digits, `PMC` prefix optional), arxiv:, a bare 10.x DOI or a doi.org URL. DOIs come back lower-cased. */
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
    case "pmc": {
      const n = /^(?:pmc)?(\d+)$/i.exec(rest.trim())?.[1]
      return n ? Effect.succeed({ scheme: "pmc", pmc: n }) : invalid("expected pmc:PMC<digits> or pmc:<digits>")
    }
    case "arxiv": {
      const id = rest.trim().replace(/v\d+$/i, "")
      return ARXIV.test(id) ? doi(`10.48550/arXiv.${id}`) : invalid("not an arXiv id")
    }
    case "http":
    case "https": {
      const m = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(input)
      if (!m) return invalid("only https://doi.org/ URLs are accepted")
      try {
        return doi(decodeURIComponent(m[1]!))
      } catch {
        return invalid("malformed percent-encoding in DOI URL")
      }
    }
  }
  return input.startsWith("10.") ? doi(input) : invalid("expected doi:, pmid:, pmc:, arxiv:, a bare 10.x DOI or a https://doi.org/ URL")
}

// ---------- CSL normalization ----------

const StrOrNum = Schema.Union([Schema.String, Schema.Number])
const StrOrList = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const Names = Schema.Array(Schema.Struct({
  family: Schema.optionalKey(Schema.String),
  given: Schema.optionalKey(Schema.String),
  literal: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String)
}))

const RawDate = Schema.optionalKey(Schema.Struct({
  "date-parts": Schema.optionalKey(Schema.Array(Schema.Array(Schema.Union([Schema.Number, Schema.String, Schema.Null]))))
}))

// What the registries actually send. Unknown keys are dropped by decoding.
export const RawCsl = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  title: StrOrList,
  subtitle: Schema.optionalKey(StrOrList),
  author: Schema.optionalKey(Names),
  editor: Schema.optionalKey(Names),
  issued: RawDate,
  // Crossref's `issued` is the earliest date, often online-first; references cite the print (issue) year.
  "published-print": RawDate,
  "journal-issue": Schema.optionalKey(Schema.Struct({ "published-print": RawDate, "published-online": RawDate })),
  "container-title": Schema.optionalKey(StrOrList),
  "container-title-short": Schema.optionalKey(StrOrList),
  "collection-title": Schema.optionalKey(StrOrList),
  volume: Schema.optionalKey(StrOrNum),
  issue: Schema.optionalKey(StrOrNum),
  page: Schema.optionalKey(StrOrNum),
  "article-number": Schema.optionalKey(StrOrNum),
  publisher: Schema.optionalKey(Schema.String),
  "publisher-place": Schema.optionalKey(Schema.String),
  // Crossref's name for publisher-place.
  "publisher-location": Schema.optionalKey(Schema.String),
  ISSN: Schema.optionalKey(StrOrList),
  ISBN: Schema.optionalKey(StrOrList),
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

// Every stored text goes through `cleanText`: entities decoded, markup reduced to what citeproc understands.
const one = (v: string | ReadonlyArray<string> | undefined) => {
  const s = typeof v === "string" ? v : v?.[0]
  return s === undefined ? undefined : cleanText(s) || undefined
}
const str = (v: string | number | undefined) => v === undefined ? undefined : cleanText(String(v)) || undefined

const decodeCsl = Schema.decodeUnknownSync(Csl)

const names = (ns: typeof Names.Type | undefined) => {
  const out = ns?.map((a) =>
    a.family || a.given
      ? { ...(a.family && { family: cleanText(a.family) }), ...(a.given && { given: cleanText(a.given) }) }
      : { literal: cleanText(a.literal ?? a.name ?? "") }
  ).filter((a) => !("literal" in a) || a.literal)
  return out?.length ? out : undefined
}
const list = (v: string | ReadonlyArray<string> | undefined) => {
  const out = (v === undefined ? [] : typeof v === "string" ? [v] : v).map(cleanText).filter(Boolean)
  return out.length ? out : undefined
}

const date = (d: typeof RawCsl.Type["issued"]) => {
  const parts = d?.["date-parts"]
    ?.map((ps) => ps.map(Number).filter((n) => Number.isFinite(n) && n > 0))
    .filter((ps) => ps.length > 0)
  return parts?.length ? { "date-parts": parts } : undefined
}

/** `title: subtitle` when the registry has a subtitle the title does not already contain. */
const fullTitle = (raw: typeof RawCsl.Type) => {
  const title = one(raw.title) ?? ""
  const sub = one(raw.subtitle)
  if (!sub || normalizeTitle(title).includes(normalizeTitle(sub))) return title
  return /[:?!.]$/.test(title) ? `${title} ${sub}` : `${title}: ${sub}`
}

export const normalizeCsl = (raw: typeof RawCsl.Type): Csl => {
  const type = cslType(raw.type)
  const earliest = date(raw.issued)
  // The print date, else the date of the issue the work appeared in (an online-only journal's issue).
  const issue = raw["journal-issue"]
  const print = date(raw["published-print"]) ?? date(issue?.["published-print"]) ?? date(issue?.["published-online"])
  const firstYear = (d: typeof print) => d?.["date-parts"][0]?.[0]
  const articleNumber = str(raw["article-number"])
  const fields = {
    type,
    title: fullTitle(raw),
    author: names(raw.author),
    // On a journal article Crossref's editor is the journal's handling editor, not an editor of the work.
    editor: type === "article-journal" ? undefined : names(raw.editor),
    issued: print ?? earliest,
    // The online-first date, kept when its year differs from the print year, so either year verifies.
    "issued-online": print && earliest && firstYear(earliest) !== firstYear(print) ? earliest : undefined,
    "container-title": one(raw["container-title"]),
    "container-title-short": one(raw["container-title-short"]),
    "collection-title": one(raw["collection-title"]),
    volume: str(raw.volume),
    issue: str(raw.issue),
    // Many journals have an article number and no pages; as `page` every style prints it.
    page: str(raw.page) ?? articleNumber,
    "article-number": articleNumber,
    publisher: one(raw.publisher),
    // PubMed puts the journal's country here ("England"); a place only belongs on books and reports.
    "publisher-place": type === "article-journal" ? undefined : one(raw["publisher-place"] ?? raw["publisher-location"]),
    ISSN: list(raw.ISSN),
    ISBN: list(raw.ISBN),
    DOI: raw.DOI && decodeEntities(raw.DOI).trim().toLowerCase(),
    PMID: str(raw.PMID),
    PMCID: str(raw.PMCID),
    URL: raw.URL && decodeEntities(raw.URL).trim(),
    language: one(raw.language)
  }
  return decodeCsl(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)))
}

// ---------- title check ----------

export const TITLE_FUZZY_THRESHOLD = 0.9

export const normalizeTitle = (s: string) =>
  decodeEntities(s.replace(/<[^>]*>/g, " "))
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

/** The part before the first subtitle separator (`: `, ` - `, ` — `), normalized; undefined without one. */
export const mainTitle = (title: string) => {
  const parts = title.split(/: | - | — /)
  return parts.length > 1 ? normalizeTitle(parts[0]!) : undefined
}

/**
 * `title` has a subtitle separator, and one side of it (10+ characters) is all of `other` (normalized):
 * the main title before it, or the title proper after a label ("Expert consensus document: <title>").
 */
const mainTitleMatches = (title: string, other: string) => {
  const main = mainTitle(title)
  if (main === undefined) return false
  const rest = normalizeTitle(title.split(/: | - | — /).slice(1).join(" "))
  return (main.length >= 10 && main === other) || (rest.length >= 10 && rest === other)
}

export type TitleResult = Pick<Verification, "titleMatch" | "expectedTitle" | "similarity">

export const checkTitle = (expected: string | undefined, actual: string): Effect.Effect<TitleResult, TitleMismatchError> => {
  if (expected === undefined) return Effect.succeed({ titleMatch: "UNCHECKED" })
  const a = normalizeTitle(expected)
  const b = normalizeTitle(actual)
  if (a === b) return Effect.succeed({ titleMatch: "VERIFIED", expectedTitle: expected, similarity: 1 })
  const score = Math.round(similarity(a, b) * 1000) / 1000
  return score >= TITLE_FUZZY_THRESHOLD || mainTitleMatches(expected, b) || mainTitleMatches(actual, a)
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

/** Applied to the whole request, retries included, so a stalled publisher redirect cannot hang a command. */
export const TIMEOUT_SECONDS = 20

/** `HTTP <status>`, a timeout, or the transport error's own message. */
export const httpFailure = (e: HttpClientError.HttpClientError | Cause.TimeoutError) =>
  Cause.isTimeoutError(e) || (e.reason._tag !== "StatusCodeError" && Cause.isTimeoutError(e.reason.cause))
    ? { status: undefined, message: `no response within ${TIMEOUT_SECONDS} s` }
    : e.reason._tag === "StatusCodeError"
    ? { status: e.reason.response.status, message: `HTTP ${e.reason.response.status}` }
    : { status: undefined, message: e.message }

const ctxp = (kind: string, id: string) => `https://pmc.ncbi.nlm.nih.gov/api/ctxp/v1/${kind}/?format=csl&id=${id}`

export const fetchCsl = Effect.fn("fetchCsl")(function*(ref: Ref) {
  const [source, url, accept, label] = ref.scheme === "doi"
    ? ["doi.org", `https://doi.org/${ref.doi.split("/").map(encodeURIComponent).join("/")}`, "application/vnd.citationstyles.csl+json", `doi:${ref.doi}`] as const
    : ref.scheme === "pmid"
    ? ["pubmed", ctxp("pubmed", ref.pmid), "*/*", `pmid:${ref.pmid}`] as const
    : ["pmc", ctxp("pmc", ref.pmc), "*/*", `pmc:PMC${ref.pmc}`] as const
  const upstream = (message: string) => new UpstreamError({ url, message: `${label}: ${message}` })

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeaders({ Accept: accept, "User-Agent": USER_AGENT })),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({ schedule: Schedule.exponential(200), times: 2 })
  )
  const body = yield* client.get(url).pipe(
    Effect.flatMap((res) => res.text),
    Effect.timeout(`${TIMEOUT_SECONDS} seconds`),
    Effect.mapError((e) => {
      const { message, status } = httpFailure(e)
      if (status === 404) return new IdentifierNotFoundError({ id: label, message: `${label}: not found at ${source}` })
      if (status === 429) return new UpstreamRateLimitError({ url, message: `${label}: rate limited by ${source} (HTTP 429)` })
      return upstream(status ? `${message} from ${source}` : `${source}: ${message}`)
    })
  )
  const json = yield* decodeJson(body).pipe(Effect.mapError(() => upstream(`${source} returned non-JSON`)))
  // The PubMed/PMC exporter 406s on any Accept but */*, and answers an unknown PMID with HTTP 200 and an empty array.
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

/** PubMed's article-identifier search covers records outside PMC as well. */
export const pubmedIdForDoi = Effect.fn("pubmedIdForDoi")(function*(doi: string) {
  const url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeader("User-Agent", USER_AGENT)),
    HttpClient.filterStatusOk
  )
  // Explicit PubMed batches run serially; space searches below NCBI's unauthenticated 3/s limit.
  yield* Effect.sleep("350 millis")
  const body = yield* client.get(url, { urlParams: {
    db: "pubmed", retmode: "json", retmax: "2", term: `"${doi}"[aid]`, tool: "ibid"
  } }).pipe(
    Effect.flatMap((r) => r.text),
    Effect.timeout(`${TIMEOUT_SECONDS} seconds`),
    Effect.mapError((e) => {
      const { message, status } = httpFailure(e)
      return status === 429
        ? new UpstreamRateLimitError({ url, message: `PubMed search rate limited: ${message}` })
        : new UpstreamError({ url, message: `PubMed search failed: ${message}` })
    })
  )
  const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
    esearchresult: Schema.Struct({ count: Schema.String, idlist: Schema.Array(Schema.String) })
  })))(body).pipe(Effect.mapError(() => new UpstreamError({ url, message: "PubMed search returned an invalid response" })))
  const { count, idlist } = result.esearchresult
  if (count === "0" && idlist.length === 0) return yield* new IdentifierNotFoundError({ id: `doi:${doi}`, message: `doi:${doi}: not found in PubMed` })
  if (!/^\d+$/.test(count) || Number(count) < 1 || idlist.some((id) => !/^\d+$/.test(id))) {
    return yield* new UpstreamError({ url, message: "PubMed search returned invalid identifiers or count" })
  }
  if (count !== "1" || idlist.length !== 1) return yield* new UpstreamError({ url, message: `doi:${doi}: ambiguous PubMed search (${count} results); choose an explicit PMID` })
  return idlist[0]!
})
