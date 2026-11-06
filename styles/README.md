# Vendored CSL files

Copied unmodified on 2026-11-06 and embedded into the binary by `src/export.ts`.

| File | Source |
| --- | --- |
| `nature.csl` | https://github.com/citation-style-language/styles `nature.csl` (master at e1273bf) |
| `gb7714.csl` | same repository, `china-national-standard-gb-t-7714-2015-numeric.csl` |
| `gb7714-2025.csl` | same repository, `china-national-standard-gb-t-7714-2025-numeric.csl` |
| `locales-zh-CN.xml` | https://github.com/citation-style-language/locales `locales-zh-CN.xml` (master at 8bef426) |

Licence: Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0), as stated in each file's `<rights>` element.
`apa`, `vancouver` and `harvard1` come bundled with `@citation-js/plugin-csl`.

## Styles and locales fetched at run time

`export --style <name>` downloads any other style from https://github.com/citation-style-language/styles
(top level, then `dependent/`, plus the parent of a dependent style) and any missing locale from
https://github.com/citation-style-language/locales, and caches them unmodified under `styles/` in the
store (for example `.ibid/styles/ieee.csl`, `.ibid/styles/locales-en-GB.xml`). These cached files are
also licensed CC BY-SA 3.0, as stated in each file's `<rights>` element; keep that notice and the
licence if you redistribute or modify them. Delete a cached file to fetch it again.
