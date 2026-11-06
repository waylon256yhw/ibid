# `ibid` 架构设计与分阶段演进文稿

## 一、背景与问题定义

在日常制作学术 PPT、整理实验数据或撰写文章时，依赖通用 Agent 或简单搜索工具处理参考文献面临两个典型问题：

1. **隐蔽的模型幻觉与张冠李戴**
   LLM 极易生成“真标题 + 假 DOI”、“真作者 + 错乱年份/期卷号”的缝合怪引用（Chimeric Citations）。这类错误高度隐蔽，人工复核或让 Agent 自我检查都极难发现。
2. **缺乏面向 Agent 的轻量本地管理层**
   * 传统桌面端工具（Zotero、EndNote）重度绑定 GUI，对纯命令行 Agent 闭环过于笨重；
   * 现有开源 CLI 工具要么是夹杂大量网页爬虫与弱类型字典的 Python 巨石（如 `papis`），要么仅仅是最后一公里的单文件排版器（如 `hayagriva`、`bibtex-tidy`），缺乏**“权威核验入库 + 二手笔记沉淀 + 按具体 PPT/文章有序聚合导出”**的中间管理层。

`ibid` 的目标是填补这一空缺：用 **TypeScript + Effect** 构建一个像操作系统原生命令一样轻巧、强类型、可演进的本地文献管理 CLI。

---

## 二、核心领域模型与本地产物结构

`ibid` 采用 **File-first（文件即真相源）** 的本地存储结构（可存放在项目目录 `.ibid/` 或全局 `~/.local/share/ibid/`）：

```text
.ibid/
├── items/                      # 1. 单篇文献本地实体（按规范化主键命名）
│   ├── doi_10.1038_s41586-020-2649-2.json
│   └── pmid_29618526.json
├── collections/                # 2. 按 Project / Article / Presentation 聚合的有序文献清单
│   ├── 2026-q4-ppt.json
│   └── review-manuscript.json
├── reports/                    # 3. 二手调研报告归档（Stage 3 吞入的外部综述或阅读笔记）
│   └── undermind-cart-review.md
└── index.sqlite                # 4. 可选派生缓存（基于 bun:sqlite FTS5 的全文检索索引，随时可重建）
```

### 1. `LiteratureItem`（单篇文献实体：`items/<id>.json`）
每篇文献由三部分组成，通过 `Effect Schema` 严格约束：
* **`canonical`（权威元数据）**：直接从 Crossref / PubMed / OpenAlex / DOI.org 获取并校验通过的标准 `CSL-JSON`（包含准确的 `title`、`author`、`issued`、`container-title`、`volume`、`issue`、`page`、`DOI`、`PMID`）。
* **`verification`（核验回执）**：记录数据来源 API、抓取时间戳、原始 payload hash、以及入库时与预期标题的匹配状态（`VERIFIED` / `FUZZY_MATCH`）。
* **`evidences`（二手资料与笔记数组）**：挂载与该文献相关的提炼信息（例如：在某次调研中的核心结论、实验数据摘录、来自 Consensus/Undermind 的匹配度与总结、关联的本地报告路径）。

### 2. `Collection`（交付物有序清单：`collections/<slug>.json`）
专门服务于某一次具体的产出（如一份 PPT、一篇论文草稿、一个子课题）：
* 维护一个**严格保序的条目数组（Ordered Entries）**；
* 每个条目除了指向 `itemId` 外，可附带在该交付物中的局部上下文（如 `context: "Slide 4: 基线模型对比"` 或 `section: "Introduction"`）；
* 导出时天然按照该清单的顺序生成 `[1], [2], [3]...` 引用列表。

---

## 三、分阶段开发路线图（Phased Roadmap）

### 第一阶段（Stage 1）：初级阶段 —— 跑通核心本体与手搓抓取闭环

**核心目标**：不依赖任何臃肿的第三方抓取器，通过 `Effect` 直接手搓对接官方权威 API 的抓取与核验管道，跑通“给 ID/标题 $\rightarrow$ 硬核验 $\rightarrow$ 本地落盘”的最小可用闭环。

1. **基础骨架与 Schema 定义**
   * 初始化 `Bun + TypeScript + Effect (@effect/cli, @effect/platform)` 工程结构。
   * 使用 `effect/Schema` 定义 `CslItemSchema`、`LiteratureItemSchema` 与标准错误类型（`IdentifierNotFoundError`、`TitleMismatchError`、`UpstreamRateLimitError`）。
2. **手搓权威源 Resolver 层**
   * **DOI Resolver**：直接对接 `https://doi.org/<DOI>`（`Accept: application/vnd.citationstyles.csl+json`）与 Crossref REST API（`https://api.crossref.org/works/<DOI>`）。
   * **PubMed / PMID Resolver**：对接 NCBI E-utilities (`esummary` / `efetch`) 获取生物医学文献精准元数据与 PMID $\leftrightarrow$ DOI 映射。
   * **OpenAlex / Title Search Fallback**：支持通过标题 + 第一作者检索候选文献，并强制比对归一化标题相似度（防止张冠李戴）。
3. **Stage 1 基础 CLI 命令**
   * `ibid add <id...>`：支持传入 `doi:...`、`pmid:...`、`arxiv:...`，可选传入 `--expect-title "..."` 进行防幻觉断言，核验通过后写入 `.ibid/items/`。
   * `ibid show <id>` / `ibid ls`：查看本地已入库文献的权威元数据与校验状态。

---

### 第二阶段（Stage 2）：第二阶段 —— 文献列表快速操作、管理与多样化输出

**核心目标**：在第一阶段本体之上，把面向具体工作流（做 PPT、写文章、管课题）的 CLI 操作做丰富、做顺手，实现“怎么聚、怎么排、怎么导都顺畅”。

1. **交付物集合与列表管理（Collections & List Manipulation）**
   * `ibid col create <name>` / `ibid col add <name> <id...> [--context "Slide 3"]`：将文献归集到指定 PPT 或文章清单中。
   * **顺序与结构操作**：支持在 CLI 中对列表进行移动重排（`move` / `reorder`）、去重合并（`dedupe`）、按年份/作者排序或保持手动插入顺序。
   * **批量核验与反查（Audit / Verify）**：
     * `ibid verify <file.bib | file.md>`：扫描现有 `.bib` 或 Markdown 文稿中的 DOI/引用，与官方源及本地库交叉核对，揪出幻觉条目或字段缺失条目。
2. **多样化导出与格式化渲染（Rich Exports）**
   * `ibid export [<collection>] --format <fmt> --style <csl>`：
     * **Markdown / Plain-text 参考文献列表**：支持 Nature、APA、Vancouver、GB/T 7714 等常用格式，按清单顺序直接输出带编号 `[1]` 或 Author-Year 的文本，一键贴入 PPT 或文稿。
     * **标准格式导出**：导出干净、去重后的 `.bib` (BibTeX) 或 `CSL-JSON` 文件。
     * **证据速查表导出（Dossier / Matrix Table）**：导出包含“序号 | 作者年份 | 标题 | 核心结论/备注 | DOI 链接”的 Markdown 表格，方便做 PPT 或写综述时快速对照。
3. **CLI 交互体验打磨**
   * 全局支持 `--json`（供 Agent 精确解析）与清爽的终端表格/卡片视图；
   * 提供适合管道组合（如配合 `fzf`、`jq`）的单行输出模式。

---

### 第三阶段（Stage 3，远期）：拓展 외부 Connector 与 MCP 生态整合

**核心目标**：打破“只能单篇硬搜”的局限，将 **Consensus**、**Undermind** 等外部深度文献检索应用产出的高价值**二手资料（文献阅读报告、相关性分析、单篇提炼结论）**无缝吞入本地库。

1. **多源 Ingest 连接器架构（Pluggable Ingest Connectors）**
   * 抽象统一的 `IngestConnector` Service 接口，实现 `ibid ingest <input> --from <connector> [--collect <name>]`：
     * **Undermind Adapter**：支持直接解析 Undermind 导出的深度调研报告（`.md`）、文献清单（`.csv` / `.bib` / `.ris`）或 MCP 输出块。自动提取其 `Match %`、单篇论文解读与综述段落，存入对应 `LiteratureItem.evidences` 及 `.ibid/reports/`，同时后台并发调用 Stage 1 的权威 Resolver 补齐并锁死所有文献的官方 `CSL-JSON`。
     * **Consensus Adapter**：解析 Consensus 导出的结果或 Thread Synthesis，保留其基于全文的要点总结（Full-text Summary）与共识度标签。
     * **通用 Markdown / BibTeX Adapter**：从任意包含 DOI/PMID 或引用的外部笔记中批量提取文献并归一化入库。
2. **MCP 双向接入**
   * **Upstream MCP Bridge**：支持在配置了 API Key / OAuth 的情况下，通过 CLI 直接拉取远程 Consensus MCP (`https://mcp.consensus.app/mcp`) 或 Undermind MCP (`https://mcp.undermind.ai/mcp`) 的检索结果并自动完成本地核验入库。
   * **Local Agent Skill / MCP Server**：为本地 Agent 提供开箱即用的 Skill 描述文件与标准工具接口。
