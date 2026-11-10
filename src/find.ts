import { Effect, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { httpFailure, normalizeTitle, similarity, TIMEOUT_SECONDS, VERSION } from "./resolve.ts"
import { UpstreamError, UpstreamRateLimitError } from "./schema.ts"

const NullOr = <S extends Schema.Top>(s: S) => Schema.optionalKey(Schema.NullOr(s))

// The fields asked for with `select`; OpenAlex sends null for anything it lacks.
export const Work = Schema.Struct({
  id: Schema.String,
  doi: NullOr(Schema.String),
  ids: NullOr(Schema.Struct({ pmid: NullOr(Schema.String) })),
  title: NullOr(Schema.String),
  type: NullOr(Schema.String),
  publication_year: NullOr(Schema.Number),
  relevance_score: NullOr(Schema.Number),
  authorships: NullOr(Schema.Array(Schema.Struct({
    author: NullOr(Schema.Struct({ display_name: NullOr(Schema.String) })),
    raw_author_name: NullOr(Schema.String)
  })))
})
export type Work = typeof Work.Type

const Works = Schema.Struct({ results: Schema.Array(Work) })

export type Candidate = {
  similarity: number
  doi?: string
  pmid?: string
  year?: number
  firstAuthor?: string
  title: string
  type?: string
  openalex: string
}

const authorsOf = (w: Work) => (w.authorships ?? []).flatMap((a) => a.author?.display_name ?? a.raw_author_name ?? [])

/**
 * Candidates by title similarity to the query (ties keep OpenAlex's order). `author` keeps
 * works with an author whose display name ends with it, i.e. a family-name match.
 */
export const rankWorks = (query: string, works: ReadonlyArray<Work>, author?: string): Array<Candidate> => {
  const q = normalizeTitle(query)
  const family = author === undefined ? undefined : ` ${normalizeTitle(author)}`
  return works
    .filter((w) => family === undefined || authorsOf(w).some((n) => ` ${normalizeTitle(n)}`.endsWith(family)))
    .map((w) => {
      const first = authorsOf(w)[0]
      const pmid = /^(?:https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)?(\d+)\/?$/.exec(w.ids?.pmid ?? "")?.[1]
      return {
        similarity: Math.round(similarity(q, normalizeTitle(w.title ?? "")) * 1000) / 1000,
        ...(w.doi && { doi: w.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() }),
        ...(pmid && { pmid }),
        ...(w.publication_year != null && { year: w.publication_year }),
        ...(first !== undefined && { firstAuthor: first }),
        title: w.title ?? "",
        ...(w.type && { type: w.type }),
        openalex: w.id
      }
    })
    .sort((a, b) => b.similarity - a.similarity)
}

/** `find` text output: similarity, DOI, year, OpenAlex work type (article, book, review, …), first author, title, PMID. */
export const findLine = (c: Candidate) =>
  [c.similarity, c.doi ? `doi:${c.doi}` : "-", c.year ?? "-", c.type ?? "-", c.firstAuthor ?? "-", c.title, c.pmid ? `pmid:${c.pmid}` : "-"].join("\t")

const URL = "https://api.openalex.org/works"

/** OpenAlex title search. Commas and pipes are filter operators, so only the normalized title is sent. */
export const searchWorks = Effect.fn("searchWorks")(function*(title: string, rows: number) {
  const query = normalizeTitle(title)
  const key = process.env.OPENALEX_API_KEY
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeaders({ Accept: "application/json", "User-Agent": `ibid/${VERSION}` })),
    HttpClient.filterStatusOk,
    // Not on 429: an exhausted daily budget does not come back in a few hundred ms.
    HttpClient.retry({
      while: (e) => HttpClient.isTransientError(e) && httpFailure(e).status !== 429,
      schedule: Schedule.exponential(200),
      times: 2
    })
  )
  const run = (how: { filter: string } | { search: string }) => client.get(URL, {
    urlParams: {
      ...how,
      "per-page": String(rows),
      select: "id,doi,ids,title,type,publication_year,authorships,relevance_score",
      ...(key && { api_key: key })
    }
  }).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Works)),
    Effect.timeout(`${TIMEOUT_SECONDS} seconds`),
    Effect.map((res) => res.results),
    Effect.mapError((e) => {
      const { message, status } = e._tag === "HttpClientError" || e._tag === "TimeoutError" ? httpFailure(e) : { message: e.message, status: undefined }
      if (status === 429) {
        return new UpstreamRateLimitError({
          url: URL,
          message: `OpenAlex rate limit or daily budget exhausted (HTTP 429); ${key ? "your OPENALEX_API_KEY budget is used up" : "set OPENALEX_API_KEY for your own budget"}`
        })
      }
      return new UpstreamError({ url: URL, message: `OpenAlex search failed: ${message}` })
    })
  )
  // The title filter needs every query word in the title, so a slightly wrong title finds
  // nothing. The general search ranks partial matches; it costs a second request only then.
  const exact = yield* run({ filter: `title.search:${query}` })
  return exact.length > 0 ? exact : yield* run({ search: query })
})

export const findCandidates = Effect.fn("findCandidates")(function*(title: string, opts: { rows?: number; author?: string } = {}) {
  return rankWorks(title, yield* searchWorks(title, opts.rows ?? 10), opts.author)
})
