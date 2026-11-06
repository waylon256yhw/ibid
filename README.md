# ibid

> **Agent-native, zero-hallucination CLI reference & literature manager built with TypeScript and Effect.**

`ibid`（源自拉丁语 *ibidem*，“出处同上”）是一个专为 AI Agent 与命令行工作流设计的轻量级本地文献管理与引用核验工具。

它不提供笨重的桌面 GUI，也不内置脆弱的网页 HTML 爬虫，而是专注于解决学术写作、数据整理与制作 PPT 过程中的核心痛点：**把大模型的“概率性文献搜索”与“确定性的元数据核验、项目归集及格式化输出”彻底解耦**。

---

## 核心设计原则

1. **零幻觉防火墙（Deterministic Verification）**
   严禁 Agent 凭记忆手写或拼接文献条目（作者、年份、期刊、期卷号、DOI）。Agent 只传递唯一标识符（`DOI` / `PMID` / `arXiv ID`）与预期标题，`ibid` 负责直接向权威注册库（Crossref、PubMed、OpenAlex、DataCite）拉取标准 `CSL-JSON`，通过 `Effect Schema` 做强类型校验与标题匹配度核验后方可入库。
2. **有状态的本地产物（Stateful Local Artifacts）**
   校验不是一锤子买卖。入库后的单篇文献、二手调研结论（如来自 Consensus / Undermind 的提炼或 Agent 的阅读笔记）、以及按具体交付物（Project / Article / Presentation）编排的有序引用清单，全部以对 Git 和 Agent 透明的纯文本结构（JSON + Markdown）持久化在本地。
3. **OS 级原子 CLI 体验（Unix & Agent Ergonomics）**
   提供干净、可组合的命令行接口。支持面向人类的紧凑终端输出，以及面向 Agent 的严格 `--json` 结构化输出。

---

## 技术栈

| 层级 | 选型 | 说明 |
| :--- | :--- | :--- |
| **Runtime & 打包** | **Bun + TypeScript** | 毫秒级冷启动，原生支持 `bun:sqlite` (FTS5)，可编译为独立单文件可执行程序 |
| **核心框架** | **Effect 4：`effect`（含 `effect/cli`、`effect/http`）+ `@effect/platform-bun`** | 强类型 `Schema` 校验、HTTP 抓取与指数退避重试、命令行解析；注意 `@effect/cli` / `@effect/platform` 仅适用于 Effect 3，本项目不使用 |
| **本地存储** | **File-first（JSON）** | `items/`、`collections/` 纯文本落盘，对 Git 与 Agent `grep`/`read_file` 完全透明；SQLite 派生索引尚未实现，`ls` 检索直接扫描文件 |
| **排版与导出** | **`@citation-js/core` + `plugin-csl` + `plugin-bibtex`（版本锁定）** | 进程内渲染 APA / Vancouver / Harvard（随库内置）及 Nature / GB/T 7714-2015 / GB/T 7714-2025（CSL 文件随仓库 vendored 于 `styles/` 并编译进二进制）；BibTeX 读写；不使用 `pandoc` 或 `hayagriva` |

---

## 用法

```bash
bun install
bun run build                      # 编译为 dist/ibid 单文件可执行程序；开发时也可直接 bun src/cli.ts <命令>

ibid add doi:10.1038/s41586-020-2649-2 --expect-title "Array programming with NumPy"
ibid add pmid:29618526 arxiv:1706.03762 10.1098/rsif.2017.0387 https://doi.org/10.1038/s41586-020-2649-2
ibid ls                            # 每行一条：id、核验状态（MANUAL 为手工条目，末尾 * 表示有本地更正）、年份、第一作者、标题、期刊（Tab 分隔）
ibid show pmid:29618526            # 也可用 doi:/arxiv: 或入库主键查看
ibid add ... --json / ibid ls --json / ibid show <id> --json   # stdout 只输出 JSON
```

* 支持的标识符：`doi:...`、`pmid:...`、`pmc:PMC5938574`（或 `pmc:5938574`，经 PMC 引用导出接口抓取，记录含 DOI 时同样以 DOI 为主键）、`arxiv:...`、以 `10.` 开头的裸 DOI、`https://doi.org/...` 链接；其他输入在联网前即报错。
* `--expect-title` 可重复：要么不给，要么按 id 顺序每个 id 给一次（如 `add A B --expect-title "标题A" --expect-title "标题B"`），个数不符为用法错误。归一化后完全一致为 `VERIFIED`，相似度 ≥ 0.9 为 `FUZZY_MATCH`；一方带副标题（以 `: `、` - `、` — ` 分隔）且其主标题（归一化后至少 10 个字符）与另一方完整标题一致时也为 `FUZZY_MATCH`（如 `Biomechanics: Mechanical Properties of Living Tissues` 对 `Biomechanics`）；否则该 id 报 `TitleMismatchError` 且不写入；未提供时状态为 `UNCHECKED`。
* 入库时保存注册库给出的 `article-number`；没有 `page` 时以文章编号作为 `page`，各样式都会输出。另保存（如有）`editor`（期刊文章除外：Crossref 在此给出的是期刊的责任编辑）、`ISBN`、`publisher-place`（Crossref 的 `publisher-location` 同样接受）、`collection-title`。
* 入库时所有文本字段解码 HTML 实体（`&amp;` → `&`），标记只保留引文引擎认识的 `<i>`、`<b>`、`<sub>`、`<sup>`（`<em>`、`<strong>`、JATS 的 italic/bold/sub/sup 映射过去），其余标签去掉、保留文字。注册库给出副标题且标题中没有时，存为 `标题: 副标题`。
* `issued` 优先取印刷日期（`published-print`，其次所在期的印刷日期，再次所在期的上线日期），即参考文献所写的卷期年份；没有时取注册库的 `issued`（最早日期，常为在线优先日期）。在线优先日期的年份与之不同时另存为 `issued-online`（非 CSL 字段，样式不输出），核验时两个年份都算一致。
* 对注册库与 OpenAlex 的每次请求（含重试）限时 20 秒，超时报 `UpstreamError`。
* 多个 id 时逐个处理，成功的照常写入；任一失败则退出码为 1。
* 对已入库条目再次 `add` 会刷新权威元数据，但保留 `evidences` 与 PubMed 给出的 `PMID` / `PMCID`；未提供 `--expect-title` 时沿用上次的预期标题重新核验，不会把 `VERIFIED` 降级为 `UNCHECKED`。
* 对已入库条目再次 `add` 同样保留 `tags` 与本地更正 `overrides`（见下文）。
* 作者列表异常时 `add` 与 `col add` 逐条提示：注册库记录没有作者，或作者多于 50 人（常见于把整个研究组成员都登记进去的记录）。人类模式下在 stderr 输出 `warning<Tab>输入<Tab>说明`，说明中给出人数并建议用 `ibid override` 更正；`--json` 时该条结果带 `warnings` 数组（无提示时为空数组）。提示不改变退出码；作者已被 `override` 更正的条目不再提示。

### 存储位置（库发现规则）

所有命令按同一规则确定库根目录（其下为 `items/` 与 `collections/`），`ibid where` 打印结果及命中的规则：

1. 设置了 `IBID_DIR` 时使用 `$IBID_DIR`（`IBID_DIR`）；
2. 否则从当前目录向上查找，使用最近一个含 `.ibid/` 的目录下的 `.ibid/`（`ancestor`），因此在项目子目录中运行同样有效；
3. 否则使用全局库 `${XDG_DATA_HOME:-~/.local/share}/ibid`（`global`）。

`ibid init` 在当前目录创建 `.ibid/`，让该项目拥有独立的库。

### 条目管理

```bash
ibid ls numpy 2020                     # 每个词都须（不区分大小写）出现在 id、标题、作者、年份、期刊或标签中
ibid ls --tag review
ibid tag pmid:29618526 dl review       # 标签以去重、排序后的 tags 数组存于条目
ibid untag pmid:29618526 review
ibid note arxiv:1706.03762 "提出 Transformer" --source "我的阅读笔记"   # 追加到 evidences，已有条目原样保留
ibid rm doi:10.1038/s41586-020-2649-2  # 被集合引用时拒绝并列出集合；--force 一并从这些集合移除
```

* 所有接受条目标识符的命令与 `show` 一致：`doi:`/`pmid:`/`pmc:`/`arxiv:`/裸 DOI/doi.org 链接，PMID、PMCID 也能找到以 DOI 为主键的条目（此时扫描全库）。
* `show` 额外显示 `language`、标签与每条 evidence 的文本。入库时若注册库提供 `language` 则一并保存。作者超过 10 人时只显示前 10 人，后接 `… (N authors)`；日期补零（`2023-05-16`）。`show --json`、`ls --json` 与 `export --format csl-json` 仍给出完整记录。

### 本地更正与无标识符文献

本地更正（overrides）与手工条目（manual）是 ibid 中仅有的两类不取自注册库的数据，因此始终单独存放、单独标示。

```bash
ibid override 10.1001/jama.2023.5942 --authors "Joseph, Philip; Roy, Ambuj; Lonn, Eva"
ibid override <id> --title T --year 2023 --journal J --volume V --issue I --page P
ibid override <id> --clear authors --clear year    # 去掉某几项更正（可重复）
ibid override <id> --clear-all                       # 去掉全部更正
ibid add --manual "WHO. Global report on hypertension. Geneva: WHO; 2023."   # 可重复，可与标识符同时给出
```

* `override` 只更正 title、authors、year、journal、volume、issue、page 这几项，至少给出一个选项，否则为用法错误。`--authors` 以 `;` 分隔人名：含逗号的为“姓, 名”（在第一个逗号处拆分），不含逗号的按原样作为团体作者（literal）。先执行 `--clear`/`--clear-all`，再写入给出的值。
* 注册库记录（`canonical`）不做任何修改；更正存于条目的 `overrides` 对象，键名为所替代的 CSL 字段（`title`、`author`、`issued`、`container-title`、`volume`、`issue`、`page`）。没有 `overrides` 的旧条目文件照常读取。更正年份时不再使用在线优先年份，更正期刊时不再使用注册库的期刊简称。
* 所有导出格式、`ls` 与 `col show` 的摘要行、`ls` 检索、`col sort`，以及 `verify` 使用库中条目时，用的都是应用更正后的记录。再次 `add` 刷新注册库记录时保留更正；`--expect-title` 仍与注册库标题比对，而非更正后的标题。
* 有更正的条目在摘要行的状态列末尾带 `*`（如 `VERIFIED*`）。`show` 对每一项更正同时列出更正值与注册库原值；`show --json` / `ls --json` 中 `canonical` 与 `overrides` 是两个独立的键。
* `add --manual "<原样的文献文本>"` 为没有 DOI/PMID 的文献建立条目，id 为 `manual:<规范化文本的 10 位哈希>`（空白合并），同一文本重复添加得到同一条目（保留其标签与笔记）。手工条目的状态为 `MANUAL`，在集合中与其他条目一样使用（`col add <集合> manual:…`、`--at`、`col move`、`col rm`），因而集合编号可与文稿的参考文献表保持一致。对手工条目执行 `override` 报用法错误；`verify` 不核验手工条目。
* 导出手工条目：`md`、`text`、`html`、`rtf` 在其位置原样输出文本，编号样式中与相邻条目同样编号（`2.`、`[2]`）；会自行排序的非编号样式（如 `apa`）把手工条目放在最后并在 stderr 提示一行，`--keep-order` 时保持原位。`bibtex` 输出 `@misc{manual<哈希>, note = {文本}}`；`csl-json` 输出 `{"id": "manual:…", "type": "document", "title": 文本, "custom": {"ibid-manual": true}}`；`dossier` 中作者年份一栏为 `(manual entry)`。

### 集合（Collections）

集合是面向单个交付物（PPT、论文、课题）的有序清单，存为 `collections/<name>.json`；名称须匹配 `^[a-z0-9][a-z0-9._-]*$`，否则报错。位置从 1 开始，即导出时的引用序号 `[1]`、`[2]`……

```bash
ibid col create q4-deck --title "Q4 组会"
ibid col add q4-deck pmid:29618526 arxiv:1706.03762 --context "Slide 3"   # 未入库的 id 走 add 的抓取核验流程
ibid col add q4-deck pmid:29618526 --section Intro                        # 已在集合中：不重复，只更新 context/section
ibid col add q4-deck 10.1038/s41586-020-2649-2 --at 1                     # 新条目插入到第 1 位
ibid col show q4-deck                  # [n]、条目摘要行，及 section/context
ibid col rm q4-deck 2 arxiv:1706.03762 # 按位置或标识符移除
ibid col move q4-deck 3 1
ibid col sort q4-deck --by year|author|title [--desc]
ibid col merge q4-deck old-deck        # 把来源中目标没有的条目按序追加；来源不变
ibid col ls / ibid col delete old-deck
```

* `col add` 同样接受可重复的 `--expect-title`（规则同 `add`）；给出标题时，每个 id（包括已入库的）都重新抓取并核验。
* `col show --json`（以及输出集合的 `col rm`、`col move`、`col sort`、`col merge` 的 `--json`）中每个条目只内嵌摘要：`{"id", "status", "year", "firstAuthor", "authorCount", "title", "journal"}`（取应用更正后的记录，`status` 与摘要行相同，可带 `*`；条目已不在库中时为 `null`），不再内嵌完整记录。完整记录用 `show --json`、`ls --json` 或 `export --format csl-json` 获取。
* 所有命令（`export` 除外）支持 `--json`（stdout 只输出 JSON）。不带 `--json` 时，失败在 stderr 输出一个空行、一行 `ERROR`，再输出缩进的错误信息，并以退出码 1 结束。带 `--json` 时，失败的命令在 stdout 恰好输出一个 JSON 值、stderr 不输出任何内容、退出码为 1：单结果命令输出 `{"error": {"_tag": ..., "message": ..., ...}}`（用法错误的 `_tag` 为 `UsageError`）；批量命令 `add`、`col add`、`rm` 与 `verify` 照常输出数组，每项自带错误或状态。例外：命令行库在进入命令之前的参数解析错误（如缺少参数、未知选项）仍以文本形式输出帮助与错误。`col add`、`rm` 与 `add` 一样逐个报告每个 id 的结果。

### 导出、核验与按标题查找

```bash
ibid export q4-deck                          # 默认 --format md --style vancouver；按集合顺序编号
ibid export q4-deck --style gb7714 --format text
ibid export q4-deck --style ieee             # CSL 官方仓库中的任意样式名，首次使用时下载并缓存
ibid export q4-deck --style ./my-journal.csl # 本地 .csl 文件
ibid export q4-deck --style apa --keep-order # 非编号样式默认按样式自身排序；此选项保持集合顺序
ibid export q4-deck --format rtf | pbcopy    # macOS：以富文本复制，可直接粘贴进 Word / Pages / WPS
ibid export q4-deck --format html > refs.html
ibid export --format bibtex > refs.bib       # 不给集合时导出整个库，按第一作者、年份排序
ibid export q4-deck --format dossier         # Markdown 速查表：序号 | 作者年份 | 标题 | 备注 | 链接
ibid find "Attention is all you need" [--author Vaswani] [--rows 10] [--json]
ibid verify draft.bib [--json]
ibid verify draft.md [--json]
ibid verify manuscript.docx [--json]         # Word 文件直接读取，并检查引用编号
```

* `export` 只写 stdout。`--format`：`md`（一行一条，保留样式中的斜体/粗体为 Markdown）、`text`、`html`（自包含的 HTML 片段，保留斜体、粗体、上标、下标；非编号样式为悬挂缩进，编号样式的序号单独对齐；在浏览器中打开后复制，或直接粘贴进 Word / Google Docs）、`rtf`（完整的 RTF 文档：保存为 `.rtf` 可直接用 Word 打开；在 macOS 上 `| pbcopy` 即以富文本放入剪贴板，因为以 RTF 头开始的输入会被识别为富文本；中文与弯引号、破折号等以 `\uN` 转义保留；每条为 0.5 英寸悬挂缩进，编号样式的序号后为制表符）、`bibtex`（中文原样保留，引用键为稳定、唯一的 ASCII，如 `harris2020array`；作者无拉丁字母时为 `ref<年份><6 位哈希>`，哈希只取决于该条目的 DOI（无则 PMID，再无则标题），因此增删其他条目不会改变已有的键；两个拉丁键相同时，每个相撞的条目都加上自己的哈希；arXiv 条目（DOI 为 `10.48550/arxiv.*` 且无期刊）输出 `journal = {arXiv preprint arXiv:<id>}`）、`csl-json`（库中记录，带 `id`）、`dossier`（备注合并集合条目的 section、context 与条目笔记）。集合中有已不在库内的条目时报错并指出是哪一条。
* `--style`（仅作用于 `md`、`text`、`html`、`rtf`）按以下顺序解析：
  1. 内置样式：`apa`、`vancouver`（默认）、`harvard`、`nature`、`gb7714`（GB/T 7714-2015 顺序编码制）、`gb7714-2025`，离线可用；
  2. 以 `.csl` 结尾的本地文件路径；
  3. [CSL 官方样式仓库](https://github.com/citation-style-language/styles) 中的任意样式名（文件名去掉 `.csl`，如 `ieee`、`chicago-author-date`、`nature-communications`）。名称只能含小写字母、数字和连字符，否则在联网前即报错。首次使用时先找仓库顶层，再找 `dependent/`，下载后缓存到存储目录下的 `styles/<name>.csl`，之后不再联网；期刊的依附样式（dependent style）按其 `independent-parent` 链接取得父样式并用父样式渲染，父样式同样缓存。请求超时为 20 秒；既无网络又无缓存时输出一行错误并以退出码 1 结束。
  
  样式所需的区域设置（`default-locale`）若本地没有（随库内置 en-US、nl-NL、fr-FR、de-DE、es-ES 及 vendored 的 zh-CN），同样从 [CSL locales 仓库](https://github.com/citation-style-language/locales) 下载并缓存为 `styles/locales-<lang>.xml`；失败时在 stderr 提示一行并改用 `en-US`。内置样式不下载区域设置，未内置的（如 `nature` 的 en-GB）直接用 `en-US`，与以前一致。
* 排序由样式本身决定（CSL 中的 `<category citation-format="…"/>`）：
  * 编号样式（numeric）始终保持集合顺序，按位置编号 `[1]`、`[2]`……；
  * 作者-年份等非编号样式默认按样式自身的排序规则排序，同一作者同一年份的 `2020a` / `2020b` 因而按阅读顺序出现；`--keep-order` 强制保持集合顺序（此时字母后缀仍按样式规则分配，可能出现 `2020b` 在前）。这是对 `apa`、`harvard` 的行为变更：以前它们保持集合顺序。
* 中英文混排：默认区域设置为中文的样式（如两个 GB/T 样式）中，`language` 以 `zh` 开头或标题含汉字的条目用该中文区域设置（多作者为“等”），其余用 `en-US`（“et al.”），两组各渲染一次（同组内一次渲染，因此能区分 `2020a` / `2020b`）。编号样式按原顺序合并、按位置重新编号（`html`、`rtf` 同样）；非编号样式按样式排序时，中文组在前、外文组在后，各组内按样式排序（与 GB/T 7714 著者-出版年制“按文种集中”一致）。其他样式整张列表用其默认区域设置（未加载时为 `en-US`）一次渲染。
* 条目有 DOI 时，参考文献列表不再重复输出注册库给出的 URL。
* 已知上游行为：`gb7714-2025` 样式对英文条目也使用全角标点（如 `，`、`（7825）`），未做修改。
* `find` 通过 OpenAlex 按标题检索候选文献（先用要求每个词都出现在标题中的 `title.search`，无结果时回退到更宽松的 `search`），按与查询标题的相似度排序，输出相似度、DOI、年份、OpenAlex 作品类型（`article`、`book`、`book-review` 等，便于区分专著与其书评）、第一作者、标题；`--author` 只保留作者姓氏匹配的候选。它不写入库，确认后用 `ibid add doi:... --expect-title "..."` 入库核验。
* OpenAlex 无密钥时共享每日少量额度（约每 IP 100 次检索）；设置 `OPENALEX_API_KEY` 后以 `api_key` 发送。额度用尽或被限流（HTTP 429）时不重试，直接给出一行提示。
* `verify` 不写入库；标识符已在库中则用库中记录（应用本地更正后），否则向注册库抓取；并发上限 3。输入文件无法读取时为用法错误（`--json` 时 `_tag` 为 `UsageError`）。结果每行：状态、位置（引用键或行号）、标识符、详情；任何一条不是 `OK` 时退出码为 1。
  * `.bib`：有 DOI（或 PMID、arXiv 号）的条目与注册库比对标题（规则同 `--expect-title`）、年份（印刷年份或在线优先年份均可）、第一作者姓氏、期刊或 booktitle、卷、期、起始页（忽略数字前的 `e`，`e2301006` 与 `2301006` 一致）。期刊名先去掉括号内容（`Antioxidants (Basel)`、`(BBA)`），再与注册库的 `container-title` 或 `container-title-short` 比较：归一化后相同、模糊相同（≥ 0.9），或去掉 of/the/and/et 等虚词后每个词都是注册库对应词的前缀（`J R Soc Interface`、`Nat. Commun.`、`Biochim Biophys Acta Mol Basis Dis`）即视为一致；缩写在哪一方都可以，一方只写另一方的首字母缩写（`PNAS`、`NEJM`、`JACC`）也算一致。注册库记录是没有期刊的 arXiv 预印本时，`arXiv`、`arXiv preprint arXiv:<id>`（即 `export --format bibtex` 的写法）、`CoRR`（及卷号 `abs/<id>`）视为惯例写法，不算声称。状态按优先级：`MISMATCH`（有字段与注册库矛盾）> `CHECK`（条目声称了注册库记录中没有的字段，如 arXiv 记录没有的期刊、卷、页；或条目缺少标题、作者、年份）> `OK`；详情列出全部发现。另有 `NOT_FOUND`；无标识符的条目按标题检索，报 `UNIDENTIFIED` 并给出相似度达 0.9 的最佳候选（检索失败时说明原因）。
  * 其他文件（Markdown、纯文本）：提取 DOI（含 Markdown 链接 `[doi:…](https://doi.org/…)`、尖括号链接与 SICI DOI）、`PMID: 12345`、`arXiv:1706.03762`。标识符的上下文：所在行属于列表（`-`、`*`、`1.`、`1)`、`1、`、`[1]`、`［1］` 以及 textutil 转出的制表符编号等标记，含到下一个标记为止的续行）时为该列表项，表格行自成一个上下文，否则为空行分隔的段落；同一标识符在每个上下文中各判断一次，报告该上下文中首次出现的行号。解析失败为 `NOT_FOUND`；注册库标题（精确或相似度 ≥ 0.9，或带副标题时的主标题）出现在上下文中为 `OK`，否则注册库第一作者姓氏与年份（两个年份之一）都出现时为 `OK`（详情说明依据）；都不满足为 `CHECK`，并给出注册库的标题、第一作者与年份供人工对照。找到标题即视为参考文献条目（而非正文引用），还须在条目中（标识符与链接除外）找到注册库的年份（任一）、卷、起始页或文章编号（注册库有的才查；`2057-62`、`e2301006` 写法均可），缺少的报 `CHECK` 并列出；表格行（如 `export --format dossier` 的输出）不做此项检查。连续的列表项中多数带标识符时，没有标识符的列表项报 `UNIDENTIFIED`（行号与开头摘录），不做标题检索。同一上下文引用了多个标识符时，标题与作者年份都只在上一个标识符与本标识符之间的文字里查找（紧邻且指向同一文献的标识符，如 DOI 后跟 PMID，共用前面的文字），佐证文字因此须写在标识符之前；这样无论在列表、无标记的参考文献行、表格还是同一句话里互换两个 DOI，都会报 `CHECK`。Markdown 链接的文字与目标地址中的 DOI 分别提取，二者不一致时都会被核验。中文作者名与标题按子串匹配，`2011年` 式的年份、全角标点后的 DOI 也能识别。
  * 网络或上游错误报 `ERROR`。
  * `.docx`（Word）文件直接读取，不必先转换：每个 Word 段落一行，与 `textutil -convert txt` 的结果一致，所以报告里的 `line N` 就是第 N 个段落。脚注、尾注附在正文之后。修订中的插入保留、删除不计；Zotero、EndNote 的域代码只取显示结果；超链接目标是 DOI 而文字里没有时，输出为 `[文字](链接)`；Word 自动编号的段落补上 `N. `。加密文件、旧版 `.doc` 或损坏的文件报一行错误。
  * 引用编号检查（纯文本、Markdown 与 `.docx`）：把 `[1]`、`[3,4]`、`[5–7, 9]` 及全角写法的数字引用与编号参考文献列表核对，报告引用了但列表中没有的编号、从未被引用的条目、首次引用未按升序出现、列表缺号或重号、同一文献重复列出，各报一条 `CHECK`；全部无误时输出一条 `OK`（位置为 `numbering`），给出条目数与引用数。参考文献列表取最后一个“References”“参考文献”等标题之后的第一段连续编号列表，没有这类标题时取最长的一段。文中没有编号列表或没有数字引用时不输出任何内容。上标数字与“作者-年份”式引用不在检查范围内。

---

## 演进路线图（Roadmap）

详细的架构设计与阶段规划见 [`docs/design-brief.md`](./docs/design-brief.md)。

- **Stage 1：初级阶段 —— 核心本体与手搓抓取落地**
  跑通最小闭环：手搓权威源 Resolver（doi.org Content Negotiation / PubMed 引用导出接口），实现单篇文献的抓取、标题防伪核验与本地 `items/` 落盘管理。（按标题检索候选文献的 OpenAlex 能力移至 Stage 2。）
- **Stage 2：第二阶段 —— 文献列表快速编排与多样化导出**
  围绕具体交付物（PPT、文章、课题）提供丰富的 CLI 列表操作（有序集合编排、批量校验 `.bib`/文稿、标签与检索）及多样化格式输出（多样式 Markdown 参考文献表、BibTeX、CSL-JSON、带二手摘要的文献速查表）。
- **Stage 3：第三阶段（远期）—— 外部 Connector 与 MCP 生态拓展**
  对接 Consensus、Undermind 等专精文献检索应用，支持吞入（Ingest）外部二手文献阅读报告与导出列表，将二手提炼结论与官方权威元数据自动对齐归档，并拓展双向 MCP 能力。
