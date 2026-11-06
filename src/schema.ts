import { Schema } from "effect"

// Stored CSL-JSON: only the fields ibid keeps. Everything else the registry sends is dropped.
export const Author = Schema.Struct({
  family: Schema.optionalKey(Schema.String),
  given: Schema.optionalKey(Schema.String),
  literal: Schema.optionalKey(Schema.String)
})

export const Csl = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  author: Schema.optionalKey(Schema.Array(Author)),
  issued: Schema.optionalKey(Schema.Struct({ "date-parts": Schema.Array(Schema.Array(Schema.Number)) })),
  "container-title": Schema.optionalKey(Schema.String),
  "container-title-short": Schema.optionalKey(Schema.String),
  volume: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
  page: Schema.optionalKey(Schema.String),
  publisher: Schema.optionalKey(Schema.String),
  ISSN: Schema.optionalKey(Schema.Array(Schema.String)),
  DOI: Schema.optionalKey(Schema.String),
  PMID: Schema.optionalKey(Schema.String),
  PMCID: Schema.optionalKey(Schema.String),
  URL: Schema.optionalKey(Schema.String)
})
export type Csl = typeof Csl.Type

export const TitleMatch = Schema.Literals(["VERIFIED", "FUZZY_MATCH", "UNCHECKED"])

export const Verification = Schema.Struct({
  source: Schema.Literals(["doi.org", "pubmed"]),
  url: Schema.String,
  fetchedAt: Schema.String,
  sha256: Schema.String,
  titleMatch: TitleMatch,
  expectedTitle: Schema.optionalKey(Schema.String),
  similarity: Schema.optionalKey(Schema.Number)
})
export type Verification = typeof Verification.Type

export const Item = Schema.Struct({
  id: Schema.String,
  canonical: Csl,
  verification: Verification,
  // Stage 1 never writes evidences; entries are opaque and kept verbatim.
  evidences: Schema.Array(Schema.Unknown)
})
export type Item = typeof Item.Type

// Every error carries a one-line `message` for humans and the --json error object.
export class InvalidIdentifierError extends Schema.TaggedError<InvalidIdentifierError>()("InvalidIdentifierError", {
  input: Schema.String,
  message: Schema.String
}) {}

export class IdentifierNotFoundError extends Schema.TaggedError<IdentifierNotFoundError>()("IdentifierNotFoundError", {
  id: Schema.String,
  message: Schema.String
}) {}

export class TitleMismatchError extends Schema.TaggedError<TitleMismatchError>()("TitleMismatchError", {
  expected: Schema.String,
  actual: Schema.String,
  similarity: Schema.Number,
  message: Schema.String
}) {}

export class UpstreamRateLimitError extends Schema.TaggedError<UpstreamRateLimitError>()("UpstreamRateLimitError", {
  url: Schema.String,
  message: Schema.String
}) {}

export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
  url: Schema.String,
  message: Schema.String
}) {}

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  path: Schema.String,
  message: Schema.String
}) {}

export type IbidError =
  | InvalidIdentifierError
  | IdentifierNotFoundError
  | TitleMismatchError
  | UpstreamRateLimitError
  | UpstreamError
  | StoreError
