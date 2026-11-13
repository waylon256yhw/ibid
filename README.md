# ibid

**面向人类与 AI Agent 的零幻觉本地文献管理与引用核验 CLI（基于 TypeScript 与 Effect 构建）。**

`ibid`（源自拉丁语 *ibidem*，“出处同上”）专注于解决学术写作、实验数据整理与制作组会 PPT 过程中的核心痛点：**把大模型的“概率性文献搜索”与“确定性的元数据核验、按交付物有序归集及多格式排版输出”彻底解耦**。

文档站点：**[https://waylon256yhw.github.io/ibid/](https://waylon256yhw.github.io/ibid/)**（源码位于 [`docs/`](./docs)，基于 [Cloudflare Nimbus](https://github.com/cloudflare/nimbus) 构建，同时产出面向人类的 HTML 站点与面向 Agent 的 Markdown / [`llms.txt`](https://waylon256yhw.github.io/ibid/llms.txt)）

---

## 快速上手（Quickstart）

### 1. 安装 CLI 与 Agent Skill

一键安装预编译单文件二进制（默认安装至 `~/.local/bin/ibid`，无需预装 Bun 或 Node.js）：

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/waylon256yhw/ibid/main/install.sh | bash

# Windows PowerShell
powershell -c "irm https://raw.githubusercontent.com/waylon256yhw/ibid/main/install.ps1 | iex"

# 或通过 Bun / npm 全局安装
bun add -g github:waylon256yhw/ibid

# 已安装后原地更新到最新版（或指定版本：ibid upgrade 0.3.0）
ibid upgrade
```

安装内置的渐进式披露 Agent Skill，让 Coding Agent（Claude Code、Gemini CLI、Cursor 等）在任意论文、PPT 或笔记工作区自动调用 `ibid`：

```bash
npx -y skills add waylon256yhw/ibid --skill ibid --global --yes
```

### 2. 典型工作流

从检索、防伪入库、归集到导出与文稿反查的典型工作流：

```bash
# 1. 按标题在 OpenAlex 中检索候选文献（只给候选，不入库）
ibid find "Array programming with NumPy" --author Harris

# 2. 凭唯一标识符入库，并用 --expect-title 做标题防伪断言
ibid add doi:10.1038/s41586-020-2649-2 --expect-title "Array programming with NumPy"
ibid add pmid:29618526 arxiv:1706.03762

# 3. 为具体交付物（PPT、文章、课题）创建有序集合并编排条目
ibid col create q4-deck --title "Q4 组会"
ibid col add q4-deck pmid:29618526 arxiv:1706.03762 10.1038/s41586-020-2649-2 --context "Slide 3"

# 4. 导出参考文献表（支持 md / text / html / rtf / brief / bibtex / csl-json / dossier）
ibid export q4-deck --style gb7714
ibid export q4-deck --style vancouver --omit pmid,pmcid # 隐藏可选标识符，不修改存储
ibid export q4-deck --format brief          # 组会/演讲 PPT 页脚短引文：Harris et al., *Nature*, 2020
ibid export q4-deck --format rtf | pbcopy   # macOS：以富文本复制，直接粘贴进 Word / Pages / WPS

# 5. 对现有 .bib、Markdown 或 Word (.docx) 文稿做交叉核验与引用编号检查
ibid verify manuscript.docx
```

---

重复 `add` 会刷新元数据，并报告 `created` / `updated`；需要 PubMed 元数据时，可显式使用 `ibid add doi:... --source pubmed --expect-title "原稿标题"`。`verify --json` 返回完整条目文本及结构化比对字段；已登记的 manual 文本精确匹配后可通过核验，表示本地确认，并非权威源证实。

## 工作原理（How it works）

- **零幻觉核验防火墙（Deterministic Verification）**
  严禁 Agent 凭记忆手写或拼接文献元数据。Agent 只传递唯一标识符（`doi:`、`pmid:`、`pmc:`、`arxiv:`、裸 `10.x` DOI 或 `https://doi.org/` 链接）与预期标题，`ibid` 直接向权威注册库（`doi.org` 内容协商、PubMed / PMC 引用导出接口、DataCite）拉取标准 `CSL-JSON`，经 `Effect Schema` 强类型校验与标题匹配度核验（`VERIFIED` / `FUZZY_MATCH`）后方可落盘。
- **有状态的本地纯文本产物（File-first Local Store）**
  按 `IBID_DIR` $\rightarrow$ 向上最近的 `.ibid/` $\rightarrow$ 全局 `${XDG_DATA_HOME:-~/.local/share}/ibid` 自动定位存储库。单篇文献（`items/`）、二手阅读笔记（`evidences`）、本地字段修正（`overrides`，与原始权威记录 `canonical` 严格隔离）以及按交付物编排的有序清单（`collections/`）全部以纯文本 JSON 存储，对 Git 与 Agent 完全透明。
- **多样式排版与文稿反查（Export & Audit）**
  进程内集成 `@citation-js/core`，内置 `vancouver`（默认）、`apa`、`harvard`、`nature`、`gb7714`、`gb7714-2025`（自动处理中英混排的“等”与“et al.”）以及面向 PPT 页脚的极简短引文样式 `brief` / `brief-num`，并支持按需从 CSL 官方仓库下载并缓存任意期刊样式；`verify` 支持直接读取 `.bib`、`.md` 与 `.docx` 文件，逐条核对元数据及 `[1]`、`[3–5]` 正文引用编号。
- **人类与 Agent 双模 CLI（Unix & Agent Ergonomics）**
  默认输出适合终端阅读与管道组合的紧凑 Tab 分隔行；传入 `--json` 时（除命令行参数语法错误仍输出标准 CLI 帮助与错误信息外）严格在 `stdout` 输出单个结构化 JSON 值，失败时 `stderr` 静默并以退出码 `1` 结束。对同一文献库的写入命令应串行执行。

---

## 命令速览（Commands）

| 命令 | 说明 |
| :--- | :--- |
| `ibid add <id...> [--expect-title ...] [--manual ...] [--source pubmed]` | 抓取、核验并入库文献，或用 `--manual` 录入无标识符文献 |
| `ibid ls [query...] [--tag <tag>]` | 多词检索或按标签过滤本地文献库 |
| `ibid show <id>` | 查看单篇条目的完整元数据、核验回执、笔记与本地修正对照 |
| `ibid override <id> [--title/--authors/--year/...]` | 本地修正指定字段（保留注册库原始 `canonical` 记录不变） |
| `ibid tag <id> <tag...>` / `ibid untag <id> <tag...>` | 为条目添加或移除标签 |
| `ibid note <id> [text] [--remove <index> \| --clear]` | 追加阅读笔记，或按 `show` 的索引删除、清空 `evidences` |
| `ibid rm <id...> [--force]` | 删除本地条目（被集合引用时需 `--force` 一并移出） |
| `ibid col <create\|ls\|show\|add\|rm\|move\|sort\|merge\|delete>` | 管理面向单个交付物（PPT、论文、课题）的有序文献集合 |
| `ibid export [collection] [--format ...] [--style ...] [--keep-order] [--omit pmid,pmcid]` | 导出参考文献列表（`md`/`text`/`html`/`rtf`）、PPT 页脚短引文（`brief`）、`bibtex`、`csl-json` 或 `dossier` 速查表 |
| `ibid find <title...> [--author ...] [--rows ...]` | 通过 OpenAlex 按标题检索候选 DOI / PMID（只给候选，不直接入库） |
| `ibid verify <file.bib \| file.md \| file.docx>` | 交叉核验文稿或 `.bib` 中的引用真实性、字段完整性与引用编号顺序 |
| `ibid init` / `ibid where` | 在当前目录初始化项目级 `.ibid/` 库 / 查看当前生效的库路径与命中规则 |

---

## 文档与架构（Documentation）

完整的使用手册、字段核验规则、样式渲染细节与路线图已拆分至 [`docs/`](./docs) 文档站点：

- **概览与快速开始**：[`docs/src/content/docs/index.mdx`](./docs/src/content/docs/index.mdx)
- **文献入库与条目管理**：[`docs/src/content/docs/items.mdx`](./docs/src/content/docs/items.mdx)
- **本地更正与无标识符文献**：[`docs/src/content/docs/overrides-and-manual.mdx`](./docs/src/content/docs/overrides-and-manual.mdx)
- **交付物集合编排**：[`docs/src/content/docs/collections.mdx`](./docs/src/content/docs/collections.mdx)
- **导出与引文样式**：[`docs/src/content/docs/export.mdx`](./docs/src/content/docs/export.mdx)
- **文稿核验与按标题检索**：[`docs/src/content/docs/verify-and-find.mdx`](./docs/src/content/docs/verify-and-find.mdx)
- **Agent 集成契约与路线图**：[`docs/src/content/docs/agent-and-roadmap.mdx`](./docs/src/content/docs/agent-and-roadmap.mdx)

在本地预览或构建文档站点：

```bash
cd docs
bun run dev     # 启动本地文档预览
bun run check   # 校验文档结构与 MDX 内容
bun run build   # 构建 HTML 站点与面向 Agent 的 Markdown / llms.txt
```

关于代码库内部架构、工程边界约束与领域不变量，请参阅 [`CLAUDE.md`](./CLAUDE.md)。
