---
name: ibid
description: Zero-hallucination local reference manager and citation verifier CLI (`ibid`). Activate whenever the task involves searching academic literature by title (`find`), fetching/verifying/storing references by DOI, PMID, PMCID, or arXiv ID (`add`), curating ordered reference collections for manuscripts or presentation slide decks (`col`), exporting formatted bibliographies or short slide-footer citations (`export` in `md`, `text`, `html`, `rtf`, `brief`, `bibtex`, `csl-json`, `dossier`), or auditing `.docx`, `.md`, and `.bib` files for hallucinated citations, metadata mismatches, and broken `[1]` reference numbering (`verify`).
---

# ibid — Verified Local Reference Manager & Citation Auditor

`ibid` decouples probabilistic literature discovery from deterministic registry verification (Crossref / `doi.org`, PubMed, PMC, DataCite), deliverable-scoped curation, multi-style formatting, and manuscript auditing.

## Preflight: Running `ibid` & Locating the Store

Invoke `ibid` directly if on `PATH`, or run it through the bundled wrapper script (which resolves symlinks back to the repository and builds `dist/ibid` if missing):

```bash
"$(dirname "$0")/scripts/ensure-ibid.sh" where
```

Store discovery order (`ibid where`):
1. `$IBID_DIR` environment variable;
2. Nearest ancestor `.ibid/` directory from `cwd` (`ibid init` creates `./.ibid/`);
3. Global store `${XDG_DATA_HOME:-~/.local/share}/ibid`.

---

## 1. Non-Negotiable Rules (Anti-Hallucination & Tool Discipline)

1. **Never fabricate or guess bibliographic metadata** (DOI, PMID, year, volume, issue, pages, or authors) from model memory. Every registry item must be fetched by `ibid` from an authoritative identifier (`doi:`, `pmid:`, `pmc:`, `arxiv:`, bare `10.x` DOI, or `https://doi.org/` URL).
2. **Always pass `--expect-title "<title>"`** when running `ibid add` or `ibid col add` on an identifier obtained from search results (`ibid find`), external notes, or a draft manuscript. `TitleMismatchError` intercepts wrong or hallucinated DOIs before anything is written to disk.
3. **Serialize write commands against the same store**: `add`, `override`, `tag`, `untag`, `note`, `rm`, and `col` mutations write via atomic single-file `rename` without cross-process locks. Never run concurrent write processes against the same store.
4. **Use `--json` for structured inspection, and default output / `export` for deliverables**:
   - Every command except `export` supports `--json`, printing a single valid JSON value on `stdout` and nothing on `stderr` (exit code `1` on failure; parser syntax errors before handler execution still print standard CLI help text).
   - Use `--json` when inspecting `warnings`, `similarity`, or `verify` findings programmatically.

---

## 2. Human-in-the-Loop Decision Boundaries (`Decisions belong to the user`)

- **Execute autonomously (no user prompt needed)**:
  - Searching candidates with `ibid find "<title>" --author <surname>`;
  - Adding verified items with `ibid add <id> --expect-title "<title>"` or `ibid col add`;
  - Appending notes (`ibid note`), managing tags (`ibid tag` / `untag`), running `ibid verify`, and exporting requested formats (`ibid export`).
- **Stop and ask the user before proceeding**:
  - When `ibid find` returns multiple plausible candidates or low title similarity (`< 0.90`);
  - When `ibid add` fails with `TitleMismatchError` or emits `authorWarnings` (`0` authors or `> 50` consortium authors) before applying `ibid override`;
  - When `ibid verify` reports `UNIDENTIFIED` entries (choosing whether to search for an identifier, store as `--manual`, or remove) or numbering errors (`missing-entry`, `uncited`, `out-of-order`, `gap`, `repeated`, `duplicate`) that require editing the user's manuscript;
  - When deciding whether to initialize a project-local `.ibid/` store (`ibid init`) vs. using the global store.

---

## 3. Core Task-Oriented Workflows

### Loop 1 — Discover & Lock (`find` $\rightarrow$ `add --expect-title` $\rightarrow$ `note`)

```bash
# 1. Search OpenAlex by title (writes nothing to the store)
# Output: <similarity>\t<doi|->\t<year|->\t<type|->\t<firstAuthor|->\t<title>
ibid find "Array programming with NumPy" --author Harris

# 2. Fetch, verify title against the authoritative registry, and lock into the store
# Output: <id>\t<VERIFIED|FUZZY_MATCH|UNCHECKED|MANUAL>[*]\t<year>\t<firstAuthor>\t<title>\t<journal>
ibid add doi:10.1038/s41586-020-2649-2 --expect-title "Array programming with NumPy"

# 3. Attach reading notes or secondary evidence
ibid note 10.1038/s41586-020-2649-2 "Defines the universal array protocol" --source "Slide 3 takeaway"
```

### Loop 2 — Deliverable Curation & Export (`col` $\rightarrow$ `export` for Papers & Slide Decks)

```bash
# Create an ordered collection for a paper or presentation deck
ibid col create q4-deck --title "Q4 Group Meeting"

# Add items (fetches unstored IDs automatically; existing entries update context/section in place without duplicating)
ibid col add q4-deck pmid:29618526 arxiv:1706.03762 10.1038/s41586-020-2649-2 \
  --expect-title "Opportunities and obstacles for deep learning in biology and medicine" \
  --expect-title "Attention Is All You Need" \
  --expect-title "Array programming with NumPy" \
  --context "Slide 3"

# Reorder entries by 1-based position or sort key
ibid col move q4-deck arxiv:1706.03762 1
ibid col sort q4-deck --by year --desc

# Export full bibliography (built-in: vancouver, gb7714, gb7714-2025, nature, apa, harvard; or any CSL repo style name)
ibid export q4-deck --style gb7714-2025
ibid export q4-deck --style nature --format rtf | pbcopy   # macOS: rich-text paste into Word / Pages / WPS

# Export compact slide-footer citations (<Author>, *<Venue>*, <Year> in collection order)
ibid export q4-deck --format brief                         # Markdown: Harris et al., *Nature*, 2020
ibid export q4-deck --style brief-num --format text        # Numbered plain text: [1] Harris et al., Nature, 2020
ibid export q4-deck --style brief --format rtf | pbcopy    # Rich-text slide footers for PowerPoint / Keynote

# Export Markdown evidence matrix (# | Author, year | Title | Notes | Link)
ibid export q4-deck --format dossier
```

### Loop 3 — Manuscript & `.docx` Audit (`verify`)

```bash
# Directly audit a .docx, .md, or .bib file against the local store and live registries (writes nothing)
# Output: <OK|MISMATCH|CHECK|NOT_FOUND|UNIDENTIFIED|ERROR>\t<location>\t<id|->\t<details>
ibid verify manuscript.docx
ibid verify references.bib --json
```

- When `ibid verify` reports non-`OK` findings (`MISMATCH`, `CHECK`, `NOT_FOUND`, `UNIDENTIFIED`, or `numbering:` issues), read [`references/verify-remediation.md`](./references/verify-remediation.md) for exact diagnostics and remediation steps.

### Loop 4 — Local Corrections & Identifier-less Works (`override` & `--manual`)

```bash
# Override specific fields locally while keeping the registry record intact in `canonical`
ibid override 10.1038/s41586-020-2649-2 --page "357–362" --authors "Harris, Charles R.; NumPy Consortium"
ibid override 10.1038/s41586-020-2649-2 --clear page       # or --clear-all

# Store a reference that has no DOI/PMID/arXiv ID (keyed as manual:<10-hex-sha256>)
ibid add --manual "World Health Organization. Global Tuberculosis Report 2023. Geneva: WHO; 2023."
```

- For detailed CSL style resolution, Chinese/English bilingual rules (`gb7714` / `gb7714-2025`), short slide-footer rules, BibTeX key behavior, and `override` semantics, read [`references/styles-and-overrides.md`](./references/styles-and-overrides.md).
