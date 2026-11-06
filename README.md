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
| **核心框架** | **`effect` + `@effect/cli` + `@effect/platform`** | 强类型 `Schema` 校验、多源 API 并发编排、指数退避重试、可插拔 `Layer` 依赖注入 |
| **本地存储** | **File-first (JSON / Markdown) + SQLite 派生索引** | `items/`、`collections/`、`reports/` 纯文本落盘，对 Git 与 Agent `grep`/`read_file` 完全透明 |
| **排版与导出** | **`@citation-js/core` (内置 CSL) + 可选 `pandoc`/`hayagriva`** | 零外部依赖渲染 Nature / APA / Vancouver / GB-T7714 等引用格式及 `.bib` 导出 |

---

## 演进路线图（Roadmap）

详细的架构设计与阶段规划见 [`docs/design-brief.md`](./docs/design-brief.md)。

- **Stage 1：初级阶段 —— 核心本体与手搓抓取落地**
  跑通最小闭环：手搓权威源 Resolver（DOI Content Negotiation / Crossref / PubMed / OpenAlex），实现单篇文献的抓取、标题防伪核验与本地 `items/` 落盘管理。
- **Stage 2：第二阶段 —— 文献列表快速编排与多样化导出**
  围绕具体交付物（PPT、文章、课题）提供丰富的 CLI 列表操作（有序集合编排、批量校验 `.bib`/文稿、标签与检索）及多样化格式输出（多样式 Markdown 参考文献表、BibTeX、CSL-JSON、带二手摘要的文献速查表）。
- **Stage 3：第三阶段（远期）—— 外部 Connector 与 MCP 生态拓展**
  对接 Consensus、Undermind 等专精文献检索应用，支持吞入（Ingest）外部二手文献阅读报告与导出列表，将二手提炼结论与官方权威元数据自动对齐归档，并拓展双向 MCP 能力。
