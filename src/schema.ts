import { Effect, Schema } from "effect"

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
  URL: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String)
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
  // Entries are opaque and kept verbatim; `note` appends `Note`s.
  evidences: Schema.Array(Schema.Unknown),
  // Sorted and unique. Stage 1 files have no `tags` key.
  tags: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))
})
export type Item = typeof Item.Type

export type Note = { text: string; source?: string; addedAt: string }

export const Collection = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  entries: Schema.Array(Schema.Struct({
    itemId: Schema.String,
    context: Schema.optionalKey(Schema.String),
    section: Schema.optionalKey(Schema.String)
  }))
})
export type Collection = typeof Collection.Type
export type Entry = Collection["entries"][number]

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

/** Missing, already existing or invalid collection, or a bad position/ref within one. */
export class CollectionError extends Schema.TaggedError<CollectionError>()("CollectionError", {
  name: Schema.String,
  message: Schema.String
}) {}

export class ItemReferencedError extends Schema.TaggedError<ItemReferencedError>()("ItemReferencedError", {
  id: Schema.String,
  collections: Schema.Array(Schema.String),
  message: Schema.String
}) {}

export type IbidError =
  | InvalidIdentifierError
  | IdentifierNotFoundError
  | TitleMismatchError
  | UpstreamRateLimitError
  | UpstreamError
  | StoreError
  | CollectionError
  | ItemReferencedError
