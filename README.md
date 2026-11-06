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
ibid ls                            # 每行一条：id、核验状态、年份、第一作者、标题、期刊（Tab 分隔）
ibid show pmid:29618526            # 也可用 doi:/arxiv: 或入库主键查看
ibid add ... --json / ibid ls --json / ibid show <id> --json   # stdout 只输出 JSON
```

* 支持的标识符：`doi:...`、`pmid:...`、`arxiv:...`、以 `10.` 开头的裸 DOI、`https://doi.org/...` 链接；其他输入在联网前即报错。
* `--expect-title`（仅限单个 id）：归一化后完全一致为 `VERIFIED`，相似度 ≥ 0.9 为 `FUZZY_MATCH`，否则报 `TitleMismatchError` 且不写入；未提供时状态为 `UNCHECKED`。
* 多个 id 时逐个处理，成功的照常写入；任一失败则退出码为 1。
* 对已入库条目再次 `add` 会刷新权威元数据，但保留 `evidences` 与 PubMed 给出的 `PMID` / `PMCID`；未提供 `--expect-title` 时沿用上次的预期标题重新核验，不会把 `VERIFIED` 降级为 `UNCHECKED`。
* 对已入库条目再次 `add` 同样保留 `tags`。

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

* 所有接受条目标识符的命令与 `show` 一致：`doi:`/`pmid:`/`arxiv:`/裸 DOI/doi.org 链接，PMID 也能找到以 DOI 为主键的条目。
* `show` 额外显示 `language`、标签与每条 evidence 的文本。入库时若注册库提供 `language` 则一并保存。

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

* 所有命令支持 `--json`（stdout 只输出 JSON）；失败时输出一行错误信息并以退出码 1 结束。`col add`、`rm` 与 `add` 一样逐个报告每个 id 的结果。

### 导出、核验与按标题查找

```bash
ibid export q4-deck                          # 默认 --format md --style vancouver；按集合顺序编号
ibid export q4-deck --style gb7714 --format text
ibid export --format bibtex > refs.bib       # 不给集合时导出整个库，按第一作者、年份排序
ibid export q4-deck --format dossier         # Markdown 速查表：序号 | 作者年份 | 标题 | 备注 | 链接
ibid find "Attention is all you need" [--author Vaswani] [--rows 10] [--json]
ibid verify draft.bib [--json]
ibid verify draft.md [--json]
```

* `export` 只写 stdout。`--format`：`md`（一行一条，保留样式中的斜体/粗体为 Markdown）、`text`、`bibtex`（中文原样保留，引用键为稳定、唯一的 ASCII，如 `harris2020array`；作者无拉丁字母时为 `ref<年份>`）、`csl-json`（库中记录，带 `id`）、`dossier`（备注合并集合条目的 section、context 与条目笔记）。集合中有已不在库内的条目时报错并指出是哪一条。
* `--style`：`apa`、`vancouver`（默认）、`harvard`、`nature`、`gb7714`（GB/T 7714-2015 顺序编码制）、`gb7714-2025`。逐条渲染：在两个 GB/T 样式中，`language` 以 `zh` 开头或标题含汉字的条目用 `zh-CN` 区域设置（多作者为“等”），其余用 `en-US`（“et al.”）；其他样式一律用 `en-US`。条目有 DOI 时，参考文献列表不再重复输出注册库给出的 URL。
* 已知上游行为：`gb7714-2025` 样式对英文条目也使用全角标点（如 `，`、`（7825）`），未做修改。
* `find` 通过 OpenAlex 按标题检索候选文献（先用要求每个词都出现在标题中的 `title.search`，无结果时回退到更宽松的 `search`），按与查询标题的相似度排序，输出相似度、DOI、年份、第一作者、标题；`--author` 只保留作者姓氏匹配的候选。它不写入库，确认后用 `ibid add doi:... --expect-title "..."` 入库核验。
* OpenAlex 无密钥时共享每日少量额度（约每 IP 100 次检索）；设置 `OPENALEX_API_KEY` 后以 `api_key` 发送。额度用尽或被限流（HTTP 429）时给出一行提示。
* `verify` 不写入库；标识符已在库中则用库中记录，否则向注册库抓取；并发上限 3。结果每行：状态、位置（引用键或行号）、标识符、详情；任何一条不是 `OK` 时退出码为 1。
  * `.bib`：有 DOI（或 PMID、arXiv 号）的条目与注册库比对标题（规则同 `--expect-title`）、年份、第一作者姓氏、卷、期、起始页：`OK` / `MISMATCH`（列出各字段的声称值与注册库值）/ `NOT_FOUND`；无标识符的条目按标题检索，报 `UNIDENTIFIED` 并给出相似度达 0.9 的最佳候选（检索失败时说明原因）。
  * 其他文件（Markdown、纯文本）：提取 DOI、`PMID: 12345`、`arXiv:1706.03762`，每个标识符报告首次出现的行号；解析失败为 `NOT_FOUND`，注册库标题出现在所在段落中为 `OK`，否则为 `CHECK` 并给出注册库标题供人工对照。
  * 网络或上游错误报 `ERROR`。

---

## 演进路线图（Roadmap）

详细的架构设计与阶段规划见 [`docs/design-brief.md`](./docs/design-brief.md)。

- **Stage 1：初级阶段 —— 核心本体与手搓抓取落地**
  跑通最小闭环：手搓权威源 Resolver（doi.org Content Negotiation / PubMed 引用导出接口），实现单篇文献的抓取、标题防伪核验与本地 `items/` 落盘管理。（按标题检索候选文献的 OpenAlex 能力移至 Stage 2。）
- **Stage 2：第二阶段 —— 文献列表快速编排与多样化导出**
  围绕具体交付物（PPT、文章、课题）提供丰富的 CLI 列表操作（有序集合编排、批量校验 `.bib`/文稿、标签与检索）及多样化格式输出（多样式 Markdown 参考文献表、BibTeX、CSL-JSON、带二手摘要的文献速查表）。
- **Stage 3：第三阶段（远期）—— 外部 Connector 与 MCP 生态拓展**
  对接 Consensus、Undermind 等专精文献检索应用，支持吞入（Ingest）外部二手文献阅读报告与导出列表，将二手提炼结论与官方权威元数据自动对齐归档，并拓展双向 MCP 能力。
