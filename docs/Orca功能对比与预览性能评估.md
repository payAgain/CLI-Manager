# Orca 功能对比与文件预览性能评估

> CLI-Manager 0.1.0 开发版；核查日期：2026-10-23。

近期适合 CLI-Manager 的方向是代码审查闭环和持久通知。文件预览已经具备文本、Markdown 和图片基础，扩展格式前应先限定加载、缓存和解码成本。本轮实现 Diff 批准及通知收件箱，文件预览只评估，不增加渲染器依赖。

## 版本与比较范围

- Orca 最新正式版为 [v1.4.237](https://github.com/stablyai/orca/releases/tag/v1.4.237)，发布于 2026-10-21，对应提交 `071747853f5995ee233b36751613f09a60007c2b`。
- 本次主线核查固定到 [main 提交 0efc842](https://github.com/stablyai/orca/commit/0efc842028a159809e8d4b4979945d3d95b8c400)，提交时间为 2026-10-23 09:16:59 UTC。后续 main 变化不包含在这个核查点内。
- 前次源码快照实际是同日的 `6d473f4`，问题在于能力总结覆盖不完整、未明确版本范围，不能简单归因于使用很旧的 Orca。
- 官网文档持续更新，下表标为“当前文档”的能力不代表全部在 v1.4.237 新增。发布说明中的 Native Chat 仍为 experimental；关闭构建开关的 layout-owner 改造不计入正式启用能力。
- CLI-Manager 对照基线为 `30f913ac`。统一快速跳转在独立 `codex/unified-quick-jump` worktree 实现；本轮验证包在 `codex/review-and-inbox` 开发分支整合快速跳转、Diff 批准和通知收件箱，主工作区基线未改动。

## 功能差异与取舍

| 领域 | Orca 当前能力与来源 | CLI-Manager 基线与建议 |
| --- | --- | --- |
| 审查反馈 | [行与行段批注、整批回送指定 Agent、解决与复审](https://www.onorca.dev/docs/review/annotate-ai-diff)；[合并 Diff、图片比较、冲突解决、行与 Hunk 暂存](https://www.onorca.dev/docs/review/diff-viewer) | 已有连续 Diff、分栏、Hunk 导航、撤销、暂存与提交。近期补内容绑定的批准；批注回送是后续独立任务，不能把两者当成同一个功能。 |
| 持久通知 | [跨工作区收件箱、重新标未读、目标跳转、Dock 数字、按机器静音](https://www.onorca.dev/docs/notifications)；[Agents feed](https://www.onorca.dev/docs/activity) | 已有 Hook、系统通知、运行态标记，缺独立持久未读。本轮补后端持久接收、收件箱和目标未读。系统通知开关与未读记录分开。 |
| 快速跳转 | [Worktree、文件、Agent、命令等统一定位](https://www.onorca.dev/docs/model/quick-open) | 独立快速跳转分支已实现项目、Worktree、存活终端、Workspan、当前工作区文件，并区分切换和新建。 |
| Worktree 进度 | [自由文本进展备注和 todo / in-progress / in-review / completed 状态](https://www.onorca.dev/docs/cli/worktree-checkpoints) | 可作为低成本后续任务。此处 Orca 的 checkpoints 是状态备注，不应误称代码快照；本项目已有代码快照与回退基础。 |
| 应用 CLI 与调度 | [应用控制 CLI](https://www.onorca.dev/docs/cli/overview)、[定时 prompt](https://www.onorca.dev/docs/cli/automations)、[多 Agent 调度](https://www.onorca.dev/docs/cli/orchestration) | 已有模板、Hook、后台任务和恢复。先考虑查询状态与打开目标的窄接口；完整依赖调度是另一条产品路线，Orchestration 仍属实验功能。 |
| 托管任务 | [GitHub 等托管评审](https://www.onorca.dev/docs/review/github)、[Linear](https://www.onorca.dev/docs/review/linear)、[Jira](https://www.onorca.dev/docs/review/jira) | 本地／WSL Git 已较完整，SSH Git 能力需按现有 transport 边界核对。可以先做任务链接、只读状态与 Worktree 关联；不急于完整多供应商同步。 |
| 代码来源 | [行级 AI／人工来源标记与元数据导出](https://www.onorca.dev/docs/review/attribution) | 没有同等追踪。依赖可靠写入来源，不宜根据文本猜测；优先级低于审查与通知。 |
| 浏览器与设计 | [每工作区浏览器](https://www.onorca.dev/docs/browser/overview)、[Design Mode 元素截图及 DOM/CSS 批注](https://www.onorca.dev/docs/browser/design-mode)、[独立 profiles](https://www.onorca.dev/docs/browser/profiles) | 当前没有内置浏览器。这是明显差异，但浏览器进程、登录与资源管理成本高，不建议直接纳入精简工作台。 |
| 远程运行 | [SSH 与配对远端 runtime、headless serve](https://www.onorca.dev/docs/ways-to-run)、[Remote Orca Servers](https://www.onorca.dev/docs/remote-servers) | 已有独立 PTY daemon、SSH Agent 与本地／WSL／SSH。完整远端 UI、手机共享和多客户端协作是更大的能力，不能和普通 SSH 混称。 |
| 手机与结构化聊天 | [Mobile companion](https://www.onorca.dev/docs/mobile)、[Native Chat](https://www.onorca.dev/docs/agents/native-chat) | 当前是终端、回答预览、历史与子代理界面。Mobile 为 Beta、Native Chat 为 Experimental；聊天协议、附件和回滚是独立产品级投入。 |
| 休眠与电脑操作 | [后台 Agent 休眠](https://www.onorca.dev/docs/agents/hibernation)、[Computer Use](https://www.onorca.dev/docs/cli/computer-use) | 当前有后台终端资源回收与恢复，不能等同于停止／唤醒 Agent。Orca 休眠默认关闭且为实验功能；Computer Use 为 Beta，暂不跟进。 |
| 富文件与发布 | [HTML、Mermaid、PDF、图片、媒体、CSV、Notebook](https://www.onorca.dev/docs/editing/viewers)、[富 Markdown](https://www.onorca.dev/docs/editing/markdown)、[Artifacts 发布](https://www.onorca.dev/docs/cli/reference#artifacts) | 当前已有文本编辑、Markdown 和图片，缺专用 PDF／网页／媒体等渲染。格式扩展先做性能预算；公开发布是账号与托管路线，不纳入本轮。 |
| 账号与用量 | [账号、供应商及用量相关设置](https://www.onorca.dev/docs/settings) | 本项目已明确移除供应商管理、请求记录、历史统计和 ccusage，不为对齐 Orca 重新引入。 |

## 本轮实现的验收定义

### Diff 批准

“批准”表示用户已审查这一版具体修改。记录按环境、SSH 主机、仓库／Worktree、文件路径和精确内容版本隔离；内容变化后需要复审。重启后保留记录，但未经重新读取核对的条目显示待核验，不用后台扫描伪造即时批准状态。

批准、撤销批准、仅待审、下一项与进度使用现有 Diff 查看器。批准前复核显示版本，发现编辑则拒绝旧批准。忽略空白、二进制、超限或无法完整呈现的差异不能当作完整内容批准。历史消息中的快照 Diff 不与当前代码批准混用。批准不调用暂存、提交或 Agent 权限放行。

新版后端返回精确审核能力标记；旧 SSH Agent 没有该标记时只允许查看，避免对旧版新增文件基线错误做出批准。合成未跟踪 Diff 同时校验原始字节指纹，记录最多保留 2000 项。

独立 SSH Agent 源码版本为 0.1.8，需部署对应新二进制后才能使用远端批准。版本递增用于兼容安装器的同版本校验和保护；本轮不发布或安装远端 Agent，主应用版本仍为 0.1.0。

### 持久未读与通知收件箱

在后端接收 Hook 时先保存可关注事件，再确认接收；事件 ID 去重，已读状态与 running／attention／done／failed 分离。应用窗口关闭后继续运行的 daemon 仍需保存事件；重开能够恢复未读。

收件箱支持目标跳转、标已读／未读、全部已读和清理已读。批量已读绑定已看到的最大序号，不能吞掉并发到达的新事件。只在目标窗格实际可见、处于焦点且未被历史／对话框覆盖时自动已读；不因显示系统通知或打开任意工作区就清空未读。

本地、WSL、SSH、Worktree 的身份与恢复后会话关联分别校验。已不存在的目标给出明确状态，不隐式新建终端。数据与列表有上限，刷新由事件和用户动作驱动，不增加周期扫描。

具体保留规则为最近 90 天、最多 2000 条，每页 50 条、游标前后翻页。升级时不强制停止承载任务的旧 daemon：它发给应用的 Hook 会补记，但旧 daemon 在整个应用退出期间仍只有原有内存缓存；完整后台持久保证从新版 daemon 启用后生效。

数据库提交后、界面广播前的崩溃窗口采用至少一次投递：重投仍更新运行状态并广播，收件箱物理记录按事件 ID 去重。普通重试由 HTTP／SSH 接收确认缓存抑制；不能把“记录已保存”当作“已经送达界面”。

### 实现验证范围

- `npx tsc --noEmit`、前端生产构建和主 crate `cargo check` 通过；使用本机已有 Rust 工具链，无需安装。
- 118 项 Node 回归通过，覆盖批准版本、持久恢复、并发写入、通知身份、分页、已读水位、手动未读、Hook 路由和跨窗格跳转。
- 61 项定向 Rust 测试通过，覆盖本地／SSH Diff、已有 Git 调用链、通知数据库重开／去重／保留、提交失败及提交后重投、Agent 版本报告；实际 `--locked` 版本命令输出 0.1.8。
- 隔离浏览器验证包含中英文、深浅主题、1440／1024／390 三种宽度的 24 组布局、18 项行为和 6 组未读徽标状态。已修复窄窗审批说明挤压、Esc 焦点恢复及徽标对比度／图标压缩。
- 浏览器使用真实组件和 Store、内存 IPC 与代表性终端 DOM；未执行真实 SSH／WSL 连接、系统通知投递、原生托盘隐藏和整机重启联调。SQLite 重开已由 Rust 测试验证，不等于完整原生场景验收。现有浅色 Diff 注释等约 3.9–4.1:1 对比度保留为主题遗留问题。

## 文件预览现状与性能成本

现有本地与 SSH 文本上限为 1 MiB，图片为 5 MiB，光栅图片另限 1200 万像素。Markdown 默认源码，用户选择后渲染；原始 HTML 不执行，嵌入图片显示文本占位而不自动联网。HTML 仅作为文本；没有专用 PDF、网页或音视频预览。

检查位置：`src/components/files/FileEditorContent.tsx`、`FileEditorPane.tsx`、`src/stores/fileExplorerStore.ts`、`src/components/ui/MarkdownContent.tsx`、`src-tauri/src/commands/fs.rs` 与 `src-tauri/ssh-agent/src/files.rs`。

| 已核实成本点 | 影响 | 后续建议 |
| --- | --- | --- |
| 文件编辑器整体懒加载，但内部静态依赖 Monaco 与 Markdown | 首次只看图片仍导入代码编辑器依赖 | 按实际文件类型拆分懒加载分支 |
| 非活动文件编辑器仅隐藏，仍挂载 | 隐藏的 Monaco、Markdown 和 Git 装饰请求仍有成本 | 传递实际可见性；暂停或卸载渲染器，保留编辑缓冲区与光标 |
| 单文件有限额，所有打开文件和工作区无总缓存预算 | 多图片、多工作区可累积内存 | 干净内容设总量／数量上限和 LRU；未保存内容不可淘汰 |
| Markdown 一次完整解析与代码高亮 | 小字节数也可能产生大量 AST／DOM；1 MiB 文档可能很昂贵 | 文档和代码块分级限制，超限默认源码 |
| 递归文件 watcher 在隐藏窗口时仍存在 | 前端跳过刷新不等于后端没有监听成本 | 预览复用现有监听，禁止额外全仓扫描与文件轮询 |
| 图片 base64 与解码表面分别占内存 | 文件大小不能充当 RAM 上限；1200 万像素 RGBA 单帧约 45.8 MiB | 显示像素预算、缩采样、动画默认首帧，SVG 默认源码 |
| `.ts` 出现在视频扩展列表 | 普通 TypeScript 文件可能被拒绝打开 | 列为独立必要修复，前端、本地后端与 SSH 分类同步验证 |

最后一个项目文件编辑器关闭时已有缓存清理，以上不是永久内存泄漏结论。后台文件监听、已有渲染器生命周期属于现有成本，不能归因于尚未实现的新预览。

### 已取得的数据

读取已构建的快速跳转 worktree 产物得到以下大小；这是 JavaScript 文件及 gzip 大小，**不是运行态 RAM、CPU 或启动耗时测量**。

| 产物 | 文件字节 | gzip 字节 |
| --- | ---: | ---: |
| monacoSetup | 3,789,368 | 973,261 |
| MarkdownContent | 552,497 | 159,617 |
| TypeScript worker | 7,010,226 | 1,531,723 |
| FileEditorPane | 19,816 | 未单独统计 |

TypeScript worker 由语言需求创建，不能把其大小算成应用启动必载。图片 base64 比原始二进制约大三分之一，解码表面还有独立成本。

Orca 也采用分级策略：Markdown 大于 600 KB 默认源码；CSV／TSV 达到 1 MiB 使用只读分页并仅绘制可见行列；媒体流式读取；Notebook 在首次运行、明确信任后才启动解释器。值得借鉴的是按需生命周期和资源限制，不是一次加入所有渲染器。[Markdown](https://www.onorca.dev/docs/editing/markdown)、[Viewers](https://www.onorca.dev/docs/editing/viewers)

### 建议预算与验证

下列为后续实现的验收目标，尚未进行运行态基准验证：

- 未使用预览时，新增后台读取、扫描、解码、网络请求为 0；不预读悬停文件，不扫描目录缩略图。
- 每次只保留当前执行任务和最新待执行任务；关闭或切换后的迟到响应不能重新挂载。
- 干净内容缓存初始预算为 32 MiB／20 文件；未保存内容独立保留。图片解码表面另行计费，不能只计算压缩文件或 base64 大小。
- Markdown 初始建议在 256 KiB 以上保留源码或要求明确加载，单代码块 50 KiB 以上不高亮。图片显示初始预算 400 万像素，超大图先缩采样，动画默认首帧。
- PDF 若以后实现，单独懒加载 worker，仅渲染可见页、缓存最多两页；HTML 默认源码，独立隔离且默认禁脚本与联网；音视频优先外部应用。

使用同一机器的 release 构建，对比不打开预览、前台使用、托盘隐藏三个场景；保持相同终端负载，每组测 5 分钟，冷／热打开各 10 次。记录 CPU、进程内存、唤醒、文件读取、SSH 传输量和打开延迟。

样本包括 10／100／1024 KiB 文本、256 KiB／1 MiB Markdown（表格／公式／长代码块）、12 MP 图片、小文件大尺寸 PNG、动画与复杂 SVG；覆盖本地／WSL／SSH。连续切换 100 文件并开关 50 轮，检查 Monaco model、worker、图片资源和 heap 是否回到稳定平台。另测不同主机同路径、Worktree、Workspan、两个同时可见分屏，防止缓存串用和误停。

本轮结论是：先收敛现有预览成本，再评估格式扩展。可承诺的目标是“未使用时无新增后台负担，使用时有明确上限”，不能在没有测量的情况下承诺绝对零性能影响。
