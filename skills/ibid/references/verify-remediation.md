# `ibid verify` Diagnostics & Remediation Guide

`ibid verify <file.bib | file.md | file.docx> [--json]` audits citations and reference lists against the local store (with `overrides` applied) and authoritative registries (`doi.org`, PubMed, PMC, DataCite) without modifying the store or the input file.

---

## 1. Finding Status Codes

| Status | Meaning | Action / Remediation |
| :--- | :--- | :--- |
| `OK` | All claimed fields match the effective record, required locators are present, and citation numbering is clean. | None required. |
| `MISMATCH` | A claimed field in a `.bib` entry contradicts the registry record (`title`, `year`, first `author` family name, `journal`, `volume`, `issue`, or first `page`). | Inspect the registry value reported in `details`. Fix the manuscript/`.bib` entry, or—if the registry metadata itself is faulty—store the item and run `ibid override <id> --<field> "<value>"`. |
| `CHECK` | Non-contradictory anomaly requiring review:<ul><li>**In `.md` / `.docx` prose**: neither the title nor `<firstAuthor> + <year>` appears near the identifier;</li><li>**In `.md` / `.docx` reference entries**: title matches, but the entry text omits the registry's `year`, `volume`, or `page`/`article-number`;</li><li>**In `.bib`**: entry claims a field absent from the registry, or lacks `title`, `author`, or `year`;</li><li>**In `numbering:`**: citation numbering issue (`missing-entry`, `uncited`, `out-of-order`, `gap`, `repeated`, `duplicate`).</li></ul> | Supply the missing locator in the reference entry, fix the swapped identifier in prose, or resolve the numbering issue (see Section 3). |
| `NOT_FOUND` | The identifier (`doi:`, `pmid:`, `pmc:`, `arxiv:`) returns HTTP 404 or an empty record from the authoritative registry. | The identifier is likely hallucinated or has a typo. Search the intended work with `ibid find "<title>" --author <surname>`, pause to confirm with the user, and replace the broken ID. |
| `UNIDENTIFIED` |<ul><li>**In `.md` / `.docx`**: a list item without an identifier inside a reference list block where $>50\%$ of items have identifiers;</li><li>**In `.bib`**: an entry without `doi`, `pmid`, or `eprint`/`arXiv` ID (`verify` automatically queries OpenAlex by title and reports the best match if similarity $\ge 0.90$).</li></ul> | If `details` suggests a matching `doi:...` ($\ge 0.90$), verify and add it with `ibid add <doi> --expect-title "<title>"`. If the work genuinely has no identifier (e.g., a government report or legacy book), ask the user whether to record it via `ibid add --manual "<text>"`. |
| `ERROR` | Network failure, rate limit (`HTTP 429`), or upstream timeout (`> 20 s`). | Retry after network recovery, or set `OPENALEX_API_KEY` if OpenAlex daily budget is exhausted. |

---

## 2. How `.docx`, Markdown, and `.bib` Inputs Are Parsed

### Word Documents (`.docx`)
- **1:1 Paragraph Line Numbers**: `ibid` extracts `word/document.xml` (followed by `footnotes.xml` and `endnotes.xml`, each separated by a blank line) with **one line per `<w:p>` paragraph**. `line N` in `ibid verify` output corresponds directly to paragraph `N` (matching `textutil -convert txt` on macOS).
- **Tracked Changes & Fields**:
  - Tracked insertions (`<w:ins>`, `<w:moveTo>`) are kept; tracked deletions (`<w:del>`, `<w:moveFrom>`) and historical property changes (`w:pPrChange`, `w:rPrChange`, `w:numberingChange`) are ignored.
  - VML fallback duplicates (`mc:Fallback`) of text boxes are skipped so citations inside text boxes are not counted twice.
  - Field instructions (`ZOTERO_ITEM`, `ADDIN EN.CITE`, `HYPERLINK`) are stripped; only the visible result text is checked.
  - Hyperlinks whose visible text does not show the DOI (e.g., `"Full text"`) but whose relationship target or `HYPERLINK` instruction contains a DOI (including percent-encoded `%2F` slashes) are expanded inline as `[Full text](https://doi.org/<doi>)` so `verify` still audits them.

### Context Isolation in Prose & Lists
- Each table row (`| ... |`), numbered/bulleted list item (including continuation lines), or blank-line-separated paragraph forms an isolated context.
- When a single context cites multiple works (e.g., `"Harris 2020 (doi:x) and Ching 2018 (doi:y)"`), only the text segment **immediately preceding each identifier** (since the previous identifier) can vouch for it. Swapped DOIs in the same sentence or paragraph are caught as `CHECK`.
- When a reference entry lists both a DOI and a PMID for the **same work** consecutively (`doi:10.1038/... PMID: 32939066`), both identifiers share the preceding entry text.

### Built-in Comparison Tolerances
- **Online-First vs. Print Years (`issued-online`)**: Crossref often records an online-first year in `issued` and a later print issue year in `published-print`. `ibid` stores both and accepts **either year** in `.bib` and prose/reference checks.
- **Electronic Article Locators**: Leading `e` prefixes (`e2301006` vs. `2301006`) and abbreviated page ranges (`2057-62` vs. `2057-2062`) are accepted.
- **Journal Abbreviations**: ISO/NLM abbreviations (`J R Soc Interface` vs. `Journal of the Royal Society Interface`), parenthetical qualifiers (`Antioxidants (Basel)`), and standard acronyms (`PNAS`, `NEJM`, `JACC`) match automatically.

---

## 3. Citation Numbering Checks (`numbering:`)

When a `.md` or `.docx` file contains both a numbered reference list (`1. `, `1) `, `[1] `, `［1］`, `1、`, or Word tab-numbered `\t1\t`) and in-text numeric citation markers (`[1]`, `[3, 4]`, `[5–7]`, `［1，2］`), `ibid verify` cross-checks them:

- **List Detection**: After an explicit heading (`References`, `Supplementary References`, `Bibliography`, `Literature Cited`, `Works Cited`, `参考文献`, `引用文献`), even a 1-entry numbered list is checked. Without a heading, `ibid` selects the longest numbered run of $\ge 2$ items so numbered section headings or protocol steps are ignored.
- **Six Finding Kinds**:
  1. `missing-entry`: `[n] is cited but the reference list has no entry n`
  2. `uncited`: `entry n is never cited`
  3. `out-of-order`: `[n] is first cited after [max]` (in sequential styles like Vancouver / Nature / GB/T 7714, references must be numbered in order of first appearance)
  4. `gap`: `no entry k between a and b` (or list starts after `1`)
  5. `repeated`: `entry number n is used twice (lines A and B)`
  6. `duplicate`: `entries a, b are the same work (same identifier | near-identical text)`

> **Remediation Workflow**: Build or update an `ibid col` collection matching the manuscript's intended citation order, then re-export the bibliography (`ibid export <collection> --style <style>`) to eliminate gaps, duplicates, and out-of-order numbering.
