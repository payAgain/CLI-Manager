# Technical Design

## State Model

继续使用 `TerminalWorkspan[]` 作为唯一布局持久化格式。关闭模式下内部仅保留一个隐藏 Workspan 容器，其 `paneTree` 即旧版全局 Pane 树，避免新增持久化 schema。

## Mode Conversion

- 关闭：选择活动 Workspan 为基准，保留其 Pane 树；按 Workspan 顺序和 Pane 遍历顺序收集其他会话，并追加到基准活动 Pane。
- 开启：不改布局拓扑，单个隐藏容器直接成为可见 Workspan。
- 启动恢复：完成旧 ID 到新 ID 映射与布局清洗后，根据设置执行同一关闭模式归并。

## UI

- 开启时继续显示 Workspan Tab 栏，单会话 Pane 隐藏本地 Tab 栏。
- 关闭时不渲染 Workspan Tab 栏，所有 Pane 显示本地 Tab 栏。
- 沿用现有挂载/过滤逻辑，避免项目聚焦时重建 xterm。
