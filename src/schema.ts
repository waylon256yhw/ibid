import { Effect, Schema } from "effect"

// Stored CSL-JSON: only the fields ibid keeps. Everything else the registry sends is dropped.
export const Author = Schema.Struct({
  family: Schema.optionalKey(Schema.String),
  given: Schema.optionalKey(Schema.String),
  literal: Schema.optionalKey(Schema.String)
})

const CslDate = Schema.Struct({ "date-parts": Schema.Array(Schema.Array(Schema.Number)) })

export const Csl = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  author: Schema.optionalKey(Schema.Array(Author)),
  editor: Schema.optionalKey(Schema.Array(Author)),
  // The print (issue) date when the registry has one, else its earliest date.
  issued: Schema.optionalKey(CslDate),
  // Not a CSL variable, so styles ignore it: the online-first date, only when its year differs from `issued`.
  "issued-online": Schema.optionalKey(CslDate),
  "container-title": Schema.optionalKey(Schema.String),
  "container-title-short": Schema.optionalKey(Schema.String),
  "collection-title": Schema.optionalKey(Schema.String),
  volume: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
  page: Schema.optionalKey(Schema.String),
  "article-number": Schema.optionalKey(Schema.String),
  publisher: Schema.optionalKey(Schema.String),
  "publisher-place": Schema.optionalKey(Schema.String),
  ISSN: Schema.optionalKey(Schema.Array(Schema.String)),
  ISBN: Schema.optionalKey(Schema.Array(Schema.String)),
  DOI: Schema.optionalKey(Schema.String),
  PMID: Schema.optionalKey(Schema.String),
  PMCID: Schema.optionalKey(Schema.String),
  URL: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String)
})
export type Csl = typeof Csl.Type

export const TitleMatch = Schema.Literals(["VERIFIED", "FUZZY_MATCH", "UNCHECKED"])

export const Verification = Schema.Struct({
  source: Schema.Literals(["doi.org", "pubmed", "pmc"]),
  url: Schema.String,
  fetchedAt: Schema.String,
  sha256: Schema.String,
  titleMatch: TitleMatch,
  expectedTitle: Schema.optionalKey(Schema.String),
  similarity: Schema.optionalKey(Schema.Number)
})
export type Verification = typeof Verification.Type

/** Local corrections typed by the user, under the CSL names of the fields they replace. */
export const Overrides = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.Array(Author)),
  issued: Schema.optionalKey(CslDate),
  "container-title": Schema.optionalKey(Schema.String),
  volume: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
  page: Schema.optionalKey(Schema.String)
})
export type Overrides = typeof Overrides.Type

const shared = {
  id: Schema.String,
  // Entries are opaque and kept verbatim; `note` appends `Note`s.
  evidences: Schema.Array(Schema.Unknown),
  // Sorted and unique. Stage 1 files have no `tags` key.
  tags: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))
}

/** A record fetched from a registry. `canonical` is never edited; `overrides` sit beside it. */
export const RegistryItem = Schema.Struct({
  ...shared,
  canonical: Csl,
  verification: Verification,
  overrides: Schema.optionalKey(Overrides)
})
export type RegistryItem = typeof RegistryItem.Type

/** A reference with no identifier, kept as the text the user gave (`id` is `manual:<hash>`). */
export const ManualItem = Schema.Struct({ ...shared, manual: Schema.String })
export type ManualItem = typeof ManualItem.Type

export const Item = Schema.Union([RegistryItem, ManualItem])
export type Item = typeof Item.Type

export const isManual = (item: Item): item is ManualItem => "manual" in item

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

/** `upgrade` could not find, check or install a release binary. */
export class UpgradeError extends Schema.TaggedError<UpgradeError>()("UpgradeError", {
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
  | UpgradeError
