# 新增设置关于模块

## Goal

将当前集成在「通用」设置页底部的「关于」区块抽取为独立的「关于」设置模块，让用户能在一个专门页面查看应用更新、项目介绍、Git 开源地址、操作手册和作者信息。

## Requirements

- 设置导航新增「关于」入口，作为独立设置页。
- 「通用」设置页不再渲染「关于」内容。
- 复用现有应用更新逻辑，不新增更新依赖或后端命令。
- 关于页展示当前版本、检查更新、下载更新、安装并重启、Release 页面兜底入口。
- 关于页补充项目介绍、GitHub 开源地址、操作手册入口和作者信息。
- 外部链接使用现有 Tauri opener 能力打开。
- 保持设置页现有视觉体系和无搜索输入规则。

## Acceptance Criteria

- [ ] 设置侧边导航显示「关于」。
- [ ] 点击「关于」后显示独立关于页，而不是通用页底部区块。
- [ ] 通用页不再包含 `AboutSection`。
- [ ] 关于页包含应用更新、项目介绍、Git 开源地址、操作手册、作者信息。
- [ ] TypeScript 类型检查通过。
- [ ] 生产构建通过。

## Definition of Done

- 变更范围只覆盖设置关于模块需要的前端文件和任务记录。
- 不新增 npm/Rust 依赖。
- 不修改 `application` 类配置或 Tauri updater 配置。
- 手动 UI 验证项在最终回复中列出。

## Technical Approach

- 新增 `AboutSettingsPage` 页面组件，内部组合现有 `AboutSection`。
- 扩展 `SettingsTab`、`SETTINGS_TAB_ORDER` 和 `SETTINGS_TAB_CONFIG`，新增稳定 tab id：`about`。
- 从 `GeneralSettingsPage` 移除 `AboutSection` import 和渲染。
- 扩展 `AboutSection` 静态内容，保留现有更新状态机和 Markdown 渲染。

## Out of Scope

- 不实现新的在线文档系统。
- 不改变自动更新 manifest、签名、下载或安装机制。
- 不改动 Release 发布流程。

## Technical Notes

- 现有更新状态位于 `src/stores/updateStore.ts`，已有 `RELEASES_URL = https://github.com/dark-hxx/CLI-Manager/releases`。
- 现有关于 UI 位于 `src/components/settings/AboutSection.tsx`，当前被 `src/components/settings/pages/GeneralSettingsPage.tsx` 引用。
- 设置导航集中在 `src/components/SettingsModal.tsx`。
- GitNexus MCP 工具未暴露；`npx --no-install gitnexus status` 显示索引 stale，`npx gitnexus analyze` 在当前 Windows 路径误判非 Git 仓库。影响范围降级为 `rg` 直接引用分析：`AboutSection` 只有通用页引用，`SettingsTab` 调用点由 TypeScript 编译覆盖。
