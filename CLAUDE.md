# ibid — Agent & Developer Context

> 如果你是接手 `ibid` 代码库的 AI Agent 或开发者，请先阅读本文档。用户与命令行的完整使用手册位于 [`docs/`](./docs)（基于 Cloudflare Nimbus 构建的文档站点）。

## 项目定位

`ibid` 是一个用 **TypeScript + Effect 4** 构建的 Agent 原生、零幻觉本地文献管理与引用核验 CLI。
核心目标是**将大模型的“概率性文献检索”与“确定性的元数据核验、按交付物（PPT/论文/课题）有序归集及多格式排版导出”彻底解耦**。

---

## 仓库目录结构

```text
ibid/
├── src/
│   ├── cli.ts              CLI 顶层入口与子命令装配（add, show, ls, override, rm, tag, untag, note, col, export, find, verify, init, where）
│   ├── col.ts              `ibid col` 子命令树（create, ls, show, add, rm, move, sort, merge, delete）
│   ├── ui.ts               人类终端摘要/详情格式化、`--json` 错误契约包装（`handle`/`report`/`Reported`）、作者列表异常告警
│   ├── schema.ts           Effect Schema 领域模型（Csl, RegistryItem, ManualItem, Overrides, Collection）与 Tagged Error 定义
│   ├── resolve.ts          标识符解析（parseId）、权威源抓取（doi.org / PubMed / PMC ctxp）、CSL 归一化（normalizeCsl）与标题核验（checkTitle）
│   ├── clean.ts            入库文本清洗：HTML 实体解码与行内标签（i/b/sub/sup）规整
│   ├── store.ts            本地库发现规则（findStore）、原子 JSON 读写（writeJsonAtomic）、主键查找（findItem）、本地更正（effective）与手工条目（addManual）
│   ├── collections.ts      集合文件读写与纯函数列表操作（1-based 位置插入、移动、稳定排序、去重合并、引用检查删除）
│   ├── export.ts           懒加载 citation-js、CSL 样式解析与远程缓存、中英混排分组渲染、7 种导出格式（md/text/html/rtf/bibtex/csl-json/dossier）
│   ├── find.ts             OpenAlex 标题检索（title.search + search 回退）、相似度排序与作者姓氏过滤
│   ├── verify.ts           `.bib`、Markdown/纯文本及 `.docx` 核验主流程（上下文切分、字段比对、缺失细节检查、未识别列表项检测）
│   ├── numbering.ts        正文数字引用（`[1]`, `[3–5]`）与编号参考文献列表的交叉核查（缺项、未引、乱序、断号、重号、重复文献）
│   ├── docx.ts             零外部依赖的 `.docx`（ZIP + WordprocessingML）文本提取器（段落、修订、域代码、DOI 超链接、自动编号、脚注/尾注）
│   └── text.d.ts           `.csl` 与 `.xml` 文本导入的 TypeScript 类型声明
├── styles/                 随二进制打包的内置 CSL 样式（nature, gb7714, gb7714-2025）与 zh-CN 区域文件
├── test/                   Bun 测试套件（7 个测试文件）与测试夹具（fixtures/）
├── docs/                   基于 @cloudflare/nimbus-docs (Astro) 的人类与 Agent 文档站
├── package.json
└── tsconfig.json
```

---

## 常用开发与构建命令

```bash
bun run check               # TypeScript 类型检查（bun check）
bun test                    # 运行全部单元测试与集成测试
bun run build               # 编译为 dist/ibid 单文件可执行程序（内嵌 styles/ 资源）
bun src/cli.ts <command>    # 开发期直接运行 CLI

# 文档站点（docs/）
cd docs && npm run dev      # 启动本地文档预览服务
cd docs && npm run check    # 运行 nimbus-docs 文档结构与内容检查
cd docs && npm run build    # 构建静态 HTML 与面向 Agent 的 Markdown / llms.txt
```

---

## 技术栈与工程边界约束（修改代码前必读）

1. **Effect 4 原生体系**
   - 本项目使用 **`effect` 4.x**（内置 `effect/cli`、`effect/http`、`effect/Schema`）配合 `@effect/platform-bun`。
   - **严禁引入** `@effect/cli` 或 `@effect/platform` 独立包（它们仅适用于 Effect 3）。
2. **引文引擎懒加载与静态资源内嵌**
   - `@citation-js/core`、`@citation-js/plugin-csl`、`@citation-js/plugin-bibtex` 必须且只能通过 [`src/export.ts`](./src/export.ts) 中的 `citeLib()` 动态 `import()` 按需加载。顶层静态导入会给所有命令增加约 20ms 的冷启动开销。
   - `styles/*.csl` 与 `styles/*.xml` 使用 `with { type: "text" }` 导入，确保 `bun build --compile` 将其内嵌进单文件二进制。
   - 初始化 BibTeX 插件时必须设置 `core.plugins.config.get("@bibtex").format.asciiOnly = false`，否则中文会被丢弃。
3. **零外部重依赖的 `.docx` 解析（[`src/docx.ts`](./src/docx.ts)）**
   - 使用 `DataView` 解析 ZIP 中央目录并用 `node:zlib` 的 `inflateRawSync` 解压，不引入第三方 ZIP 或 XML 库。
   - 每个 `<w:p>` 输出为一行，与 macOS `textutil -convert txt` 的行号严格对齐，使 `verify` 报告中的 `line N` 恰好对应第 N 个段落。
   - 跳过 `<w:del>`、`<w:moveFrom>`、`w:pPrChange`、`w:rPrChange`、`w:numberingChange` 与 `mc:Fallback`（避免文本框 VML 副本重复提取）。
4. **File-first 存储与原子写入（[`src/store.ts`](./src/store.ts)）**
   - 库发现优先级：`IBID_DIR` 环境变量 $\rightarrow$ 从 `cwd` 向上查找最近的 `.ibid/` $\rightarrow$ `${XDG_DATA_HOME:-~/.local/share}/ibid`。
   - 所有落盘均通过 `writeJsonAtomic`（先写 `<path>.<pid>.tmp` 再 `rename`）完成。
   - 目前未启用 SQLite 索引：`findItem` 用 `doi:` 查找时直接读单文件；用 `pmid:` 或 `pmc:` 查找以 DOI 为主键的条目时会调用 `listItems()` 扫描全库（几百篇规模下开销极小）。

---

## 核心领域不变量（Invariants）

### 1. 主键归一与文件名映射
- 只要注册库记录含有 `DOI`，条目主键一律为 `doi:<小写 DOI>`（即使最初通过 `pmid:` 或 `pmc:` 抓取）；无 DOI 但有 `PMID` 时为 `pmid:<n>`；否则回退到输入标识符 `pmc:<n>`。
- 无标识符的手工条目主键为 `manual:<规范化文本 SHA-256 前 10 位 hex>`。
- 磁盘文件名为 `<scheme>_<encodeURIComponent(其余部分)>.json`，可通过 `keyFromFileName` 无损还原。

### 2. `canonical` 与 `overrides` 严格分离
- `RegistryItem.canonical` 保存从权威源抓取并经 `normalizeCsl` 规整后的记录，**落盘后绝不直接人为篡改**。
- 用户通过 `ibid override` 写入的修正保存在同级的 `overrides` 对象中（仅限 `title`、`author`、`issued`、`container-title`、`volume`、`issue`、`page`）。
- 所有导出、`ls`/`col show` 摘要、检索排序、以及 `verify` 读取本地条目时，一律通过 `effective(item)` 获取合并后的生效记录（若覆盖了 `issued` 则丢弃 `issued-online`；若覆盖了 `container-title` 则丢弃 `container-title-short`）。
- 再次 `add` 同一条目刷新权威元数据时，必须保留原有的 `evidences`、`tags`、`overrides`、PubMed 的 `PMID`/`PMCID`，并在未传 `--expect-title` 时沿用上次的 `expectedTitle` 重新与 `canonical.title` 比对。

### 3. 入库归一化规则（[`normalizeCsl`](./src/resolve.ts)）
- **日期优先级**：`issued` 优先取印刷日期（`published-print` $\rightarrow$ `journal-issue.published-print` $\rightarrow$ `journal-issue.published-online`），其次才取注册库的 `issued`（常为在线优先日期）。若在线优先年份与印刷年份不同，另存为非 CSL 字段 `issued-online`，`verify` 时两个年份均视为一致。
- **页码回退**：没有 `page` 时以 `article-number` 作为 `page` 存储，确保各 CSL 样式均能输出文章编号。
- **字段剔除**：`type === "article-journal"` 时丢弃 `editor`（Crossref 中为期刊责任编辑）与 `publisher-place`（PubMed 中为期刊出版国）。
- **文本清洗**：所有文本字段经 `cleanText` 解码 HTML 实体，并将 `<em>`/`<strong>`/JATS 标签映射为 citeproc 识别的 `<i>`/`<b>`/`<sub>`/`<sup>`，剥离其余标签。若 `subtitle` 未包含在 `title` 中，拼接为 `标题: 副标题`。

### 4. CLI 与 `--json` 错误契约（[`src/ui.ts`](./src/ui.ts)）
- 除 `export` 外，所有命令均支持 `--json`。
- 带 `--json` 时，`stdout` 必须且只能输出**一个合法的 JSON 值**：
  - 单结果命令失败时，在 `stdout` 输出 `{"error": {"_tag": "...", "message": "...", ...}}`（用法错误的 `_tag` 为 `UsageError`），`stderr` 不输出任何内容，抛出静默的 `Reported` 错误使进程以退出码 `1` 结束。
  - 批量命令（`add`、`col add`、`rm`、`verify`）即使部分失败也正常在 `stdout` 输出完整结果数组（每项自带 `ok: false, error: ...` 或非 `OK` 状态），随后通过 `Reported` 以退出码 `1` 结束。
- 作者列表异常（0 人或超过 50 人，且未被 `override` 修正）在 `add` / `col add` 时作为 `warning` 提示（人类模式写 `stderr`，`--json` 模式放入该条结果的 `warnings` 数组），**不改变退出码**。
