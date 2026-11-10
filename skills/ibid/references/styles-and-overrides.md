# Styles, Formats, Overrides & Manual Entries Reference

## 1. Export Formats (`--format`) & Styles (`--style`)

`ibid export [collection] [--format <fmt>] [--style <style>] [--keep-order] [--omit pmid,pmcid]` formats a collection (in collection order) or the entire store (sorted by first author, then year, with manual entries last).

### Formats (`--format`)

| Format | Description |
| :--- | :--- |
| `md` (default) | One Markdown line per reference, preserving `*italics*` and `**bold**` from CSL. |
| `text` | Plain text, one line per reference. |
| `html` | Self-contained HTML fragment (`<meta charset="utf-8">` + `<div class="csl-bib-body">`) with hanging indents and fixed-width number boxes. Paste from a browser into Word or Google Docs. |
| `rtf` | Complete RTF document (`{\rtf1\ansi...`) with 0.5-inch hanging indents (`\li720\fi-720\tx720`) and Unicode `\uN` escapes. On macOS, pipe to `pbcopy` (`ibid export <col> --format rtf \| pbcopy`) to copy rich text directly into Word, PowerPoint, Keynote, Pages, or WPS. |
| `brief` | Short slide-footer micro-citations in Markdown (`<Author>, *<Venue>*, <Year>`, e.g., `Harris et al., *Nature*, 2020`). Combine with `--style brief-num` for `[1] <Author>, *<Venue>*, <Year>`. |
| `bibtex` | UTF-8 BibTeX (Chinese characters preserved verbatim). |
| `csl-json` | Effective CSL-JSON array (with `overrides` applied; manual entries carry `"custom": {"ibid-manual": true}`). |
| `dossier` | Markdown table (`# \| Author, year \| Title \| Notes \| Link`) combining collection `section`, `context`, and item `evidences` notes. |

### Identifier Omission (`--omit`)

Accepts `doi`, `pmid`, `pmcid`, `url`, comma-separated or repeatable. Applies to copies of effective records for `md`, `text`, `html`, and `rtf` only. Other formats reject the option. Stored metadata and manual text remain unchanged. Omitting `doi` does not omit `url`; specify both when needed.

### Style Resolution (`--style`)

`--style` applies to `md`, `text`, `html`, and `rtf` (plus `brief-num` with `--format brief`):

1. **Built-in CSL Styles (offline)**:
   - `vancouver` (default, numeric)
   - `nature` (numeric, bundled `.csl`)
   - `gb7714` (GB/T 7714-2015 numeric, bundled `.csl`)
   - `gb7714-2025` (GB/T 7714-2025 numeric, bundled `.csl`)
   - `apa` (author-date, sorted)
   - `harvard` (author-date, sorted)
2. **Built-in Short Slide-Footer Styles (offline, zero `citation-js` startup overhead)**:
   - `brief`: Unnumbered `<Author>, *<Venue>*, <Year>` across `md`, `text`, `html`, and `rtf`.
   - `brief-num`: Numbered `[1] <Author>, *<Venue>*, <Year>` across `md`, `text`, `html`, and `rtf`.
   - **Slot rules**:
     - `<Author>`: Western names use family name (`Einstein` / `Smith & Doe` / `Harris et al.`); Chinese entries (`isChinese(c)`) use full Chinese names (`王五` / `张三, 李四` / `崔巍 等`). Omitted when the record has no authors.
     - `<Venue>`: Priority fallback chain: `container-title-short` $\rightarrow$ `container-title` $\rightarrow$ `arXiv` (for `10.48550/arxiv.*` preprints) $\rightarrow$ `collection-title` $\rightarrow$ `publisher`. Italicized in `md`, `html`, and `rtf`; plain in `text`.
     - `<Year>`: 4-digit year from `issued`, or `n.d.`.
     - Always preserves collection order by default.
3. **Local `.csl` File Path**: Any path ending in `.csl` (e.g., `./my-journal.csl`).
4. **On-Demand CSL Repository Styles**:
   - Any style slug matching `^[a-z0-9][a-z0-9-]*$` from `citation-style-language/styles` (e.g., `ieee`, `cell`, `lancet`, `chicago-author-date`, `elsevier-harvard`).
   - Fetched once from top-level or `dependent/` (resolving `independent-parent` automatically) and cached in `<store>/styles/<name>.csl`; required `locales-<lang>.xml` files are cached in `<store>/styles/` as well.

### Chinese/English Bilingual Rendering (`gb7714` & `gb7714-2025`)
- For styles whose `default-locale` starts with `zh`:
  - Items with `language: "zh*"` or Han characters in `title` render under `zh-CN` (`等`);
  - Other items render under `en-US` (`et al.`);
  - Numeric styles merge both batches back in collection order and renumber `1..N`. Non-numeric styles place the Chinese group first, then the English group.

### BibTeX Citation Keys (`--format bibtex`)
- Keys are pure ASCII: `<family><year><first title word >3 chars>` (e.g., `harris2020array`), or `ref<year><6-hex-hash>` when the first author has no Latin letters.
- If two exported entries share the same `<family><year><word>` base key, both append their own 6-hex item hash (derived from DOI $\rightarrow$ PMID $\rightarrow$ title, independent of list order).
- **Important**: Adding or removing an entry that introduces or resolves a base-key collision switches the affected entries between `<base>` and `<base><hash>`. Update `\cite{...}` keys in the manuscript after re-exporting.

---

## Metadata Source Selection and Refresh

`find --json` includes a numeric-string `pmid` when OpenAlex provides one. To explicitly select PubMed metadata, use:

```bash
ibid add doi:10.1098/rsif.2017.0387 --source pubmed \
  --expect-title "Opportunities and obstacles for deep learning in biology and medicine"
```

DOI inputs reuse a local PMID or query PubMed ESearch, then require the fetched DOI to match before title verification and writing. Zero/multiple search results or a missing/mismatched DOI fail without replacing the existing item. PMID inputs are also accepted; PMC inputs and `--manual` cannot be combined with `--source pubmed`.

`add` refreshes according to each invocation: a later `add doi:...` without the flag fetches from `doi.org`. Existing overrides, tags, evidences, and PubMed IDs survive refresh. Successful results, including manual adds, have `action: "created" | "updated"`; source changes additionally expose `previousSource`. `show` displays the active registry source. Check existing overrides if a source refresh appears not to change rendered output.

## 2. Local Overrides (`ibid override`) vs. `canonical`

`RegistryItem.canonical` stores the normalized authoritative record from the registry and is **never mutated by user edits**. `ibid override` writes to a sibling `overrides` object:

| Flag | CSL Field | Notes |
| :--- | :--- | :--- |
| `--title "<text>"` | `title` | Must be non-empty. |
| `--authors "<list>"` | `author` | `;`-separated: `"Family, Given; Family, Given"`. A name without a comma becomes a group/literal author (`{ "literal": "WHO" }`). |
| `--year <int>` | `issued` | Positive integer year. Automatically hides `canonical["issued-online"]` in `effective(item)`. |
| `--journal "<text>"` | `container-title` | Automatically hides `canonical["container-title-short"]` in `effective(item)`. |
| `--volume "<text>"` | `volume` | Volume string. |
| `--issue "<text>"` | `issue` | Issue string. |
| `--page "<text>"` | `page` | Page range or article number. |
| `--clear <field>` | (drops override) | Repeatable (`title`, `authors`, `year`, `journal`, `volume`, `issue`, `page`). |
| `--clear-all` | (drops all) | Restores `effective(item)` to `canonical`. |

- **Author Warnings**: When `canonical.author` has `0` authors and `overrides.author` is not set, `add` and `col add` emit a non-fatal warning suggesting `ibid override <id> --authors "..."`. Always ask the user before overriding authors.

---

## 3. Identifier-less Works (`ibid add --manual`)

For works that genuinely have no DOI, PMID, PMCID, or arXiv ID (such as internal clinical guidelines, historic books, or unpublished standards):

```bash
ibid add --manual "National Health Commission. Chinese Guidelines for Heart Failure 2024. Chin J Cardiol. 2024;52(3):235-275."
```

- Stored under `manual:<10-hex-sha256-of-normalized-text>` (re-adding the same text is idempotent and preserves existing `tags` and `evidences`; returns `created` initially and `updated` on re-add).
- Participates in `col add`, `col move`, `col rm`, `tag`, `note`, and `export`:
  - Numeric and `brief` styles print the manual text at its collection position with the surrounding numbering style;
  - Sorting styles (`apa`, `harvard`) place manual entries at the end unless `--keep-order` is passed;
  - `bibtex` exports `@misc{manual<hash>, note = {...}}`;
  - Cannot be modified with `ibid override` (re-add corrected text with `ibid add --manual` instead).

- `verify` accepts exact normalized local manual text as `OK` with `matchedBy: "manual-text"`; this is local confirmation, not external registry verification. In `.bib`, it checks the decoded `note` of identifier-less `@misc` entries, not just their citation keys. Export escapes literal TeX special characters so the text survives parsing.
